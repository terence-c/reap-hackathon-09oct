// Gate edge cases on the mock Reap adapter and an injected clock: approval races and timeouts,
// what an approval re-checks, checkout outcomes, the simulated (no card) path, budget holds,
// velocity, the tool registry and audit tampering.

import { describe, expect, it, vi } from "vitest";
import * as audit from "@/lib/safr/audit";
import { committed, getReservation, loadMandate, saveMandate } from "@/lib/safr/controls";
import {
  APPROVAL_WINDOW_MS,
  checkoutIdForEnvelope,
  GateError,
  recordCheckoutOutcome,
  simulatedCheckout,
} from "@/lib/safr/gate";
import {
  authorizeToolCall,
  listToolDenials,
  listToolEvents,
  recordToolDenied,
  setAgentStatus,
  toolTraceFor,
} from "@/lib/safr/registry";
import { VELOCITY_WINDOW_MS } from "@/lib/safr/windows";
import type { Quote } from "@/lib/types";
import { AGENT_ID, MINUTE, setup } from "./helpers";

const MANDATE = "mandate-001";
const TAG = "byndartisan-luggage-tag"; // S$85 + S$5 shipping = S$90 → ESCALATE
const BOOK = "popular-ghost-stories-12"; // S$10.79 + S$5 = S$15.79 → AUTO_EXECUTE
const BEER = "brewlander-6pack"; // DENY CATEGORY_OUT_OF_SCOPE

type Env = ReturnType<typeof setup>;

async function propose(env: Env, sku: string, quantity = 1) {
  const q = await env.quote(sku, quantity);
  const result = await env.gate.proposeCheckout({ quoteId: q.id, reason: `buy ${sku}`, sessionId: "s" });
  return { q, result };
}

function rulesFor(envelopeHash: string) {
  return audit.latestForEnvelope(envelopeHash)?.disposition.rulesFired;
}

// Words that would claim a purchase happened; the gate must never say these before Reap's COMPLETED.
const CLAIMS_ORDER = /\b(ordered|purchased|order (was )?placed|paid for|payment (is )?complete|completed)\b/i;

describe("approvals: single use", () => {
  it("a second approve is a 409 and creates no second checkout", async () => {
    const env = setup();
    const { result: tag } = await propose(env, TAG);
    expect(tag.decision).toBe("ESCALATE");
    expect(tag.message).toContain(`expires in ${APPROVAL_WINDOW_MS / MINUTE} minutes`);
    expect(getReservation(tag.envelopeHash)?.status).toBe("RESERVED");

    const first = await env.gate.approve(tag.envelopeHash, "terence");
    expect(first).toMatchObject({ decision: "AUTO_EXECUTE", checkoutId: expect.any(String) });
    const second = await env.gate.approve(tag.envelopeHash, "terence").catch((e: unknown) => e);
    expect(second).toBeInstanceOf(GateError);
    expect(second).toMatchObject({ code: "ALREADY_DECIDED", status: 409 });
    await expect(env.gate.decline(tag.envelopeHash, "terence")).rejects.toMatchObject({ status: 409 });
    expect(env.reap.checkoutsCreated()).toBe(1);
    expect(getReservation(tag.envelopeHash)?.status).toBe("RESERVED"); // still held for the live checkout
  });

  it("two approvals racing: exactly one wins", async () => {
    const env = setup();
    const { result: tag } = await propose(env, TAG);
    const results = await Promise.allSettled([env.gate.approve(tag.envelopeHash, "a"), env.gate.approve(tag.envelopeHash, "b")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(env.reap.checkoutsCreated()).toBe(1);
  });

  it("decline releases the hold; a second decline (or an approve) is a 409 and logs nothing", async () => {
    const env = setup();
    const { result: tag } = await propose(env, TAG);
    expect(committed(MANDATE).reserved).toBe(9000);

    const declined = await env.gate.decline(tag.envelopeHash, "terence");
    expect(declined).toMatchObject({ decision: "DENY", envelopeHash: tag.envelopeHash });
    expect(getReservation(tag.envelopeHash)?.status).toBe("RELEASED");
    expect(committed(MANDATE)).toEqual({ reserved: 0, settled: 0 });
    expect(rulesFor(tag.envelopeHash)).toEqual(["HUMAN_DECLINED"]);
    const entries = audit.list().length;

    await expect(env.gate.decline(tag.envelopeHash, "terence")).rejects.toMatchObject({ code: "ALREADY_DECIDED", status: 409 });
    await expect(env.gate.approve(tag.envelopeHash, "terence")).rejects.toMatchObject({ status: 409 });
    expect(audit.list()).toHaveLength(entries);
    expect(env.reap.checkoutsCreated()).toBe(0);
  });

  it("an unknown envelope is a 404", async () => {
    const env = setup();
    await expect(env.gate.decline("a".repeat(64), "terence")).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });
});

describe("approvals: timeout (injected clock)", () => {
  it("expires exactly at the window, logs APPROVAL_TIMEOUT, releases the hold, then refuses approve", async () => {
    const env = setup();
    const { result: tag } = await propose(env, TAG);

    env.clock.advance(APPROVAL_WINDOW_MS - 1);
    expect(env.gate.expireStaleApprovals()).toBe(0);
    expect(env.gate.listPendingApprovals()).toHaveLength(1);

    env.clock.advance(1);
    expect(env.gate.expireStaleApprovals()).toBe(1);
    expect(env.gate.expireStaleApprovals()).toBe(0); // idempotent
    expect(env.gate.listPendingApprovals()).toEqual([]);
    expect(getReservation(tag.envelopeHash)?.status).toBe("RELEASED");
    expect(committed(MANDATE).reserved).toBe(0);

    const timeout = audit.latestForEnvelope(tag.envelopeHash)!;
    expect(timeout.disposition).toMatchObject({ decision: "DENY", rulesFired: ["APPROVAL_TIMEOUT"] });
    expect(timeout.disposition.reason).toContain("within 5 minutes");
    expect(timeout.ts).toBe(new Date(env.clock.t).toISOString());
    expect(audit.list().filter((e) => e.disposition.rulesFired.includes("APPROVAL_TIMEOUT"))).toHaveLength(1);

    await expect(env.gate.approve(tag.envelopeHash, "terence")).rejects.toMatchObject({ code: "ALREADY_DECIDED", status: 409 });
    await expect(env.gate.decline(tag.envelopeHash, "terence")).rejects.toMatchObject({ status: 409 });
    expect(env.reap.checkoutsCreated()).toBe(0);
    expect(audit.verifyChain().ok).toBe(true);
  });

  it("a late approve expires the request itself (no other call needed first)", async () => {
    const env = setup();
    const { result: tag } = await propose(env, TAG);
    env.clock.advance(APPROVAL_WINDOW_MS + MINUTE);
    await expect(env.gate.approve(tag.envelopeHash, "terence")).rejects.toMatchObject({ status: 409 });
    expect(rulesFor(tag.envelopeHash)).toEqual(["APPROVAL_TIMEOUT"]);
    expect(getReservation(tag.envelopeHash)?.status).toBe("RELEASED");
  });
});

describe("approvals: everything is re-checked", () => {
  it("mandate edited (threshold raised): envelope rebuilt with a new hash; the hold moves to it", async () => {
    const env = setup();
    const { result: tag } = await propose(env, TAG);
    saveMandate({ ...loadMandate(), autoThreshold: 10000 });

    const createCheckout = vi.spyOn(env.reap, "createCheckout");
    const approved = await env.gate.approve(tag.envelopeHash, "terence");
    expect(approved).toMatchObject({ decision: "AUTO_EXECUTE", checkoutId: expect.any(String) });
    expect(approved.envelopeHash).not.toBe(tag.envelopeHash);

    const rebuilt = audit.latestForEnvelope(approved.envelopeHash)!;
    expect(rebuilt.envelope.context.mandateVersion).toBe(2);
    expect(rebuilt.disposition.rulesFired).toEqual(["HUMAN_APPROVED"]); // no longer over the threshold
    expect(getReservation(tag.envelopeHash)?.status).toBe("RELEASED");
    expect(getReservation(approved.envelopeHash)?.status).toBe("RESERVED");
    expect(committed(MANDATE).reserved).toBe(9000); // moved, not doubled
    expect(createCheckout).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: approved.envelopeHash }));
    expect(checkoutIdForEnvelope(approved.envelopeHash)).toBe(approved.checkoutId);
    expect(checkoutIdForEnvelope(tag.envelopeHash)).toBeNull();
    expect(audit.verifyChain().ok).toBe(true);
  });

  it("mandate edited (kill switch on): rebuilt envelope is denied KILL_SWITCH and the hold released", async () => {
    const env = setup();
    const { result: tag } = await propose(env, TAG);
    saveMandate({ ...loadMandate(), killSwitch: true });

    const result = await env.gate.approve(tag.envelopeHash, "terence");
    expect(result.decision).toBe("DENY");
    expect(result.envelopeHash).not.toBe(tag.envelopeHash);
    expect(result.message).toMatch(/^Approved by terence, but blocked on re-check: /);
    expect(result.message).not.toMatch(CLAIMS_ORDER);
    expect(rulesFor(result.envelopeHash)).toEqual(["KILL_SWITCH"]);
    expect(audit.latestForEnvelope(result.envelopeHash)!.envelope.context.mandateVersion).toBe(2);
    expect(getReservation(tag.envelopeHash)?.status).toBe("RELEASED");
    expect(getReservation(result.envelopeHash)).toBeNull();
    expect(committed(MANDATE).reserved).toBe(0);
    expect(env.reap.checkoutsCreated()).toBe(0);
  });

  it("budget cut below what is already committed: DENY OVER_REMAINING_BUDGET on approval", async () => {
    const env = setup();
    const { result: tag } = await propose(env, TAG); // 9000 held
    const { result: pegboard } = await propose(env, "ergotune-pegboard"); // S$64 > the S$60 left
    expect(pegboard.decision).toBe("DENY");
    expect(rulesFor(pegboard.envelopeHash)).toEqual(["OVER_REMAINING_BUDGET"]);
    const { result: book } = await propose(env, BOOK); // 1579 fits
    expect(book.decision).toBe("AUTO_EXECUTE");
    saveMandate({ ...loadMandate(), totalBudget: 10000 }); // 10000 − 1579 = 8421 < 9000

    const result = await env.gate.approve(tag.envelopeHash, "terence");
    expect(result.decision).toBe("DENY");
    expect(rulesFor(result.envelopeHash)).toEqual(["OVER_REMAINING_BUDGET"]);
    expect(getReservation(tag.envelopeHash)?.status).toBe("RELEASED");
    expect(committed(MANDATE).reserved).toBe(1579);
  });

  it("agent revoked while waiting: DENY IDENTITY_REVOKED, hold released, nothing sent to Reap", async () => {
    const env = setup();
    const { result: tag } = await propose(env, TAG);
    setAgentStatus(AGENT_ID, "REVOKED");

    const result = await env.gate.approve(tag.envelopeHash, "terence");
    expect(result).toMatchObject({ decision: "DENY", envelopeHash: tag.envelopeHash });
    expect(rulesFor(tag.envelopeHash)).toEqual(["IDENTITY_REVOKED"]);
    expect(getReservation(tag.envelopeHash)?.status).toBe("RELEASED");
    expect(env.reap.checkoutsCreated()).toBe(0);
    await expect(env.gate.approve(tag.envelopeHash, "terence")).rejects.toMatchObject({ status: 409 });
  });
});

describe("approvals: quote refresh", () => {
  it("expired quote → re-quoted, re-signed, executed under the new envelope", async () => {
    const env = setup();
    const { q, result: tag } = await propose(env, TAG);
    env.clock.advance(MINUTE);
    env.reap.expireQuote(q.id);
    const createQuote = vi.spyOn(env.reap, "createQuote");

    const result = await env.gate.approve(tag.envelopeHash, "terence");
    expect(createQuote).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ decision: "AUTO_EXECUTE", checkoutId: expect.any(String) });
    const rebuilt = audit.latestForEnvelope(result.envelopeHash)!.envelope;
    expect(rebuilt.action.quoteId).not.toBe(q.id);
    expect(rebuilt.action.items).toEqual([{ sku: TAG, quantity: 1 }]);
    expect(rebuilt.context.quoteExpiresAt).toBe(new Date(env.clock.t + 10 * MINUTE).toISOString());
    expect(getReservation(tag.envelopeHash)?.status).toBe("RELEASED");
    expect(getReservation(result.envelopeHash)?.status).toBe("RESERVED");
  });

  it("quote no longer readable at Reap → re-quoted instead of failing the approval", async () => {
    const env = setup();
    const { result: tag } = await propose(env, TAG);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const getQuote = env.reap.getQuote.bind(env.reap);
    env.reap.getQuote = async (id) => {
      if (id === audit.latestForEnvelope(tag.envelopeHash)!.envelope.action.quoteId) throw new Error("QUOTE_NOT_FOUND");
      return getQuote(id);
    };
    const result = await env.gate.approve(tag.envelopeHash, "terence");
    expect(result).toMatchObject({ decision: "AUTO_EXECUTE", checkoutId: expect.any(String) });
    expect(result.envelopeHash).not.toBe(tag.envelopeHash);
    vi.restoreAllMocks();
  });

  it("re-quote fails too → DENY QUOTE_UNAVAILABLE and the hold is released", async () => {
    const env = setup();
    const { q, result: tag } = await propose(env, TAG);
    env.reap.expireQuote(q.id);
    env.reap.createQuote = async () => {
      throw new Error("AGENTIC_SERVICE_UNAVAILABLE");
    };
    const result = await env.gate.approve(tag.envelopeHash, "terence");
    expect(result.decision).toBe("DENY");
    expect(result.message).toContain("AGENTIC_SERVICE_UNAVAILABLE");
    expect(rulesFor(tag.envelopeHash)).toEqual(["QUOTE_UNAVAILABLE"]);
    expect(getReservation(tag.envelopeHash)?.status).toBe("RELEASED");
  });

  it("re-quote costs more than what was approved → DENY QUOTE_CHANGED", async () => {
    const env = setup();
    const { q, result: tag } = await propose(env, TAG);
    env.reap.expireQuote(q.id);
    const createQuote = env.reap.createQuote.bind(env.reap);
    env.reap.createQuote = async (input) => {
      const fresh = await createQuote(input);
      return { ...fresh, finalAmount: { ...fresh.finalAmount, amount: fresh.finalAmount.amount + 100 } };
    };
    const result = await env.gate.approve(tag.envelopeHash, "terence");
    expect(result.decision).toBe("DENY");
    expect(rulesFor(result.envelopeHash)).toEqual(["QUOTE_CHANGED"]);
    expect(result.message).toContain("S$91.00, more than the S$90.00 that was approved");
    expect(getReservation(tag.envelopeHash)?.status).toBe("RELEASED");
    expect(env.reap.checkoutsCreated()).toBe(0);
  });

  it("same quote id re-priced at Reap (not expired) → rebuilt and DENY QUOTE_CHANGED, never the stale amount", async () => {
    const env = setup();
    const { q, result: tag } = await propose(env, TAG);
    const repriced: Quote = { ...q, finalAmount: { amount: 9500, currency: "SGD" } };
    env.reap.getQuote = async () => repriced;
    const result = await env.gate.approve(tag.envelopeHash, "terence");
    expect(result.decision).toBe("DENY");
    expect(rulesFor(result.envelopeHash)).toEqual(["QUOTE_CHANGED"]);
    expect(getReservation(tag.envelopeHash)?.status).toBe("RELEASED");
    expect(env.reap.checkoutsCreated()).toBe(0);
  });

  it("re-quote comes back in another currency → QUOTE_CHANGED without claiming it costs more", async () => {
    const env = setup();
    const { q, result: tag } = await propose(env, TAG);
    env.reap.getQuote = async () => ({ ...q, finalAmount: { amount: 7000, currency: "USD" } });
    const result = await env.gate.approve(tag.envelopeHash, "terence");
    expect(rulesFor(result.envelopeHash)).toEqual(["QUOTE_CHANGED"]);
    expect(result.message).not.toContain("more than");
    expect(result.message).toContain("no longer matches");
  });

  it("re-quote is cheaper → executes at the new, lower amount", async () => {
    const env = setup();
    const { q, result: tag } = await propose(env, TAG);
    env.reap.getQuote = async () => ({ ...q, finalAmount: { amount: 8900, currency: "SGD" } });
    const result = await env.gate.approve(tag.envelopeHash, "terence");
    expect(result.decision).toBe("AUTO_EXECUTE");
    expect(getReservation(result.envelopeHash)?.amount).toEqual({ amount: 8900, currency: "SGD" });
    expect(committed(MANDATE).reserved).toBe(8900);
  });
});

describe("checkout outcomes", () => {
  it("COMPLETED settles, FAILED / EXPIRED release, repeats are idempotent, a late COMPLETED still settles", async () => {
    const env = setup();
    const { result: book } = await propose(env, BOOK);
    const id = book.checkoutId!;
    expect(getReservation(book.envelopeHash)?.status).toBe("RESERVED");

    expect(recordCheckoutOutcome(id, "REQUIRES_ACTION")?.reservation?.status).toBe("RESERVED");
    expect(recordCheckoutOutcome(id, "PROCESSING")?.reservation?.status).toBe("RESERVED");
    expect(recordCheckoutOutcome(id, "FAILED")).toMatchObject({ envelopeHash: book.envelopeHash, reservation: { status: "RELEASED" } });
    expect(recordCheckoutOutcome(id, "FAILED")?.reservation?.status).toBe("RELEASED");
    expect(recordCheckoutOutcome(id, "EXPIRED")?.reservation?.status).toBe("RELEASED");
    expect(committed(MANDATE)).toEqual({ reserved: 0, settled: 0 });

    // Reap completed after all (e.g. the human approved on Reap's page late): the money is spent.
    expect(recordCheckoutOutcome(id, "COMPLETED")?.reservation?.status).toBe("SETTLED");
    expect(recordCheckoutOutcome(id, "COMPLETED")?.reservation?.status).toBe("SETTLED");
    expect(recordCheckoutOutcome(id, "FAILED")?.reservation?.status).toBe("SETTLED"); // never un-spends
    expect(committed(MANDATE)).toEqual({ reserved: 0, settled: 1579 });
  });

  it("EXPIRED releases a held checkout", async () => {
    const env = setup();
    const { result: book } = await propose(env, BOOK);
    expect(recordCheckoutOutcome(book.checkoutId!, "EXPIRED")?.reservation?.status).toBe("RELEASED");
  });

  it("an unknown checkout id changes nothing", () => {
    setup();
    expect(recordCheckoutOutcome("chk_unknown", "COMPLETED")).toBeNull();
  });

  it("Reap answers FAILED straight away → hold released, nothing claimed", async () => {
    const env = setup();
    env.reap.createCheckout = async () => ({ id: "chk_failed", status: "FAILED" });
    const { result: book } = await propose(env, BOOK);
    expect(book).toMatchObject({ decision: "AUTO_EXECUTE", checkoutId: "chk_failed" });
    expect(book.message).toContain("nothing was charged");
    expect(getReservation(book.envelopeHash)?.status).toBe("RELEASED");
  });

  it("no checkout id for a denied, a pending or an unknown envelope", async () => {
    const env = setup();
    const { result: beer } = await propose(env, BEER);
    const { result: tag } = await propose(env, TAG);
    expect(beer.decision).toBe("DENY");
    expect(checkoutIdForEnvelope(beer.envelopeHash)).toBeNull();
    expect(checkoutIdForEnvelope(tag.envelopeHash)).toBeNull();
    expect(checkoutIdForEnvelope("0".repeat(64))).toBeNull();
  });

  it("gate messages never claim an order was placed", async () => {
    const env = setup();
    const messages = [
      (await propose(env, BOOK)).result.message,
      (await propose(env, TAG)).result.message,
      (await propose(env, BEER)).result.message,
    ];
    env.clock.advance(MINUTE);
    messages.push((await propose(env, BOOK)).result.message); // OBSERVE
    const tagHash = env.gate.listPendingApprovals()[0].envelopeHash;
    messages.push((await env.gate.approve(tagHash, "terence")).message);
    for (const message of messages) expect(message).not.toMatch(CLAIMS_ORDER);
    expect(messages[0]).toContain("Awaiting your approval on Reap's page");
  });
});

describe("simulated checkout (DEMO_SIMULATE_WITHOUT_CARD)", () => {
  const noCard = () => {
    throw new Error("no card has been added yet");
  };

  it("flag on and no card → simulated: no Reap call, labeled, COMPLETED with a SIMULATED- order id", async () => {
    const env = setup({ gate: { simulateWithoutCard: () => true, enrollmentId: noCard } });
    const createCheckout = vi.spyOn(env.reap, "createCheckout");
    const { result: book } = await propose(env, BOOK);
    expect(createCheckout).not.toHaveBeenCalled();
    expect(book.decision).toBe("AUTO_EXECUTE");
    expect(book.checkoutId).toMatch(/^sim_[0-9a-f]{24}$/);
    expect(book.approvalUrl).toBeUndefined();
    expect(book.message).toContain("simulated checkout");
    expect(book.message).not.toMatch(CLAIMS_ORDER);
    expect(audit.latestForEnvelope(book.envelopeHash)).toMatchObject({ executed: true, checkoutId: book.checkoutId });

    const sim = simulatedCheckout(book.checkoutId!);
    expect(sim).toMatchObject({ id: book.checkoutId, status: "COMPLETED", finalAmount: { amount: 1579, currency: "SGD" } });
    expect(sim!.orderId).toMatch(/^SIMULATED-[0-9A-F]{8}$/);
    expect(recordCheckoutOutcome(sim!.id, sim!.status)?.reservation?.status).toBe("SETTLED");
  });

  it("flag on but a card is active → the real Reap checkout", async () => {
    const env = setup({ gate: { simulateWithoutCard: () => true } });
    const { result: book } = await propose(env, BOOK);
    expect(env.reap.checkoutsCreated()).toBe(1);
    expect(book.checkoutId).not.toMatch(/^sim_/);
    expect(simulatedCheckout(book.checkoutId!)).toBeNull();
  });

  it("flag off and no card → no checkout, hold released, says nothing was charged", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const env = setup({ gate: { simulateWithoutCard: () => false, enrollmentId: noCard } });
    const { result: book } = await propose(env, BOOK);
    expect(env.reap.checkoutsCreated()).toBe(0);
    expect(book.checkoutId).toBeUndefined();
    expect(book.message).toContain("no card has been added yet");
    expect(book.message).toContain("nothing was charged");
    expect(getReservation(book.envelopeHash)?.status).toBe("RELEASED");
    vi.restoreAllMocks();
  });

  it("simulatedCheckout ignores real ids and unknown sim_ ids", () => {
    setup();
    expect(simulatedCheckout("mock_checkout_1")).toBeNull();
    expect(simulatedCheckout("sim_000000000000000000000000")).toBeNull();
  });
});

describe("budget holds and velocity", () => {
  it("holds count against the budget: OVER_REMAINING_BUDGET, then fits again once a hold is released", async () => {
    const env = setup();
    const { result: tag } = await propose(env, TAG); // 9000 held
    const { result: two } = await propose(env, "ergotune-pegboard", 2); // 12300 > 6000 left
    expect(rulesFor(two.envelopeHash)).toEqual(["OVER_REMAINING_BUDGET"]);
    expect(two.message).toContain("S$60.00 left");
    expect(getReservation(two.envelopeHash)).toBeNull(); // a DENY holds nothing

    await env.gate.decline(tag.envelopeHash, "terence");
    const { result: one } = await propose(env, "ergotune-pegboard"); // 6400 ≤ 15000
    expect(one.decision).toBe("AUTO_EXECUTE");
    expect(committed(MANDATE).reserved).toBe(6400);
  });

  it("settled purchases count too", async () => {
    const env = setup();
    for (let i = 0; i < 9; i++) {
      const { result } = await propose(env, BOOK);
      recordCheckoutOutcome(result.checkoutId!, "COMPLETED");
      env.clock.advance(VELOCITY_WINDOW_MS); // keep each one clear of the velocity window
    }
    expect(committed(MANDATE)).toEqual({ reserved: 0, settled: 9 * 1579 }); // 14211, 789 left
    const { result } = await propose(env, BOOK);
    expect(rulesFor(result.envelopeHash)).toEqual(["OVER_REMAINING_BUDGET"]);
  });

  it("a repeat from the same merchant within 15 minutes is OBSERVE; after the window it is AUTO_EXECUTE again", async () => {
    const env = setup();
    expect(VELOCITY_WINDOW_MS).toBe(15 * MINUTE);
    const { result: first } = await propose(env, BOOK);
    expect(first.decision).toBe("AUTO_EXECUTE");

    env.clock.advance(14 * MINUTE);
    const { result: repeat } = await propose(env, BOOK);
    expect(repeat.decision).toBe("OBSERVE");
    expect(rulesFor(repeat.envelopeHash)).toEqual(["VELOCITY"]);
    expect(repeat.message).toContain("within 15 minutes");
    expect(repeat.checkoutId).toEqual(expect.any(String)); // OBSERVE still executes

    env.clock.advance(15 * MINUTE + 1); // 15 min + 1 ms after the repeat, 29 min after the first
    const { result: later } = await propose(env, BOOK);
    expect(later.decision).toBe("AUTO_EXECUTE");
    expect(rulesFor(later.envelopeHash)).toEqual([]);
  });

  it("a released hold does not count toward velocity; another merchant never does", async () => {
    const env = setup();
    const { result: first } = await propose(env, BOOK);
    recordCheckoutOutcome(first.checkoutId!, "FAILED");
    expect((await propose(env, BOOK)).result.decision).toBe("AUTO_EXECUTE");
    expect((await propose(env, "kinokuniya-conan-106")).result.decision).toBe("AUTO_EXECUTE");
  });
});

describe("registry: tool calls", () => {
  it("authorizeToolCall records allowed and denied calls; events come back oldest first", () => {
    setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(authorizeToolCall({ sessionId: "s1", agentId: AGENT_ID, tool: "listCatalog", now: 1000 })).toBe(true);
    expect(authorizeToolCall({ sessionId: "s1", agentId: AGENT_ID, tool: "createCheckout", now: 2000 })).toBe(false);
    expect(authorizeToolCall({ sessionId: "s1", agentId: AGENT_ID, tool: "getQuote", now: 3000 })).toBe(true);
    expect(authorizeToolCall({ sessionId: "s2", agentId: "someone-else", tool: "listCatalog", now: 4000 })).toBe(false);
    recordToolDenied({ sessionId: "s1", agentId: AGENT_ID, tool: "transferFunds", now: 5000 });
    expect(warn).toHaveBeenCalledTimes(3);

    const events = listToolEvents();
    expect(events.map((e) => [e.type, e.toolName])).toEqual([
      ["TOOL_CALL", "listCatalog"],
      ["TOOL_DENIED", "createCheckout"],
      ["TOOL_CALL", "getQuote"],
      ["TOOL_DENIED", "listCatalog"],
      ["TOOL_DENIED", "transferFunds"],
    ]);
    expect(events.map((e) => e.seq)).toEqual([...events.map((e) => e.seq)].sort((a, b) => a - b));
    expect(events[0].ts).toBe(new Date(1000).toISOString());
    expect(listToolEvents(2).map((e) => e.toolName)).toEqual(["listCatalog", "transferFunds"]); // the latest two, still oldest first

    expect(listToolDenials().map((d) => d.tool)).toEqual(["transferFunds", "listCatalog", "createCheckout"]); // newest first
    expect(toolTraceFor("s1")).toEqual(["listCatalog", "getQuote"]); // allowed calls only
    vi.restoreAllMocks();
  });
});

describe("audit tampering", () => {
  it("tamperForDemo breaks the chain at the edited row (latest by default)", async () => {
    const env = setup();
    await propose(env, BOOK);
    await propose(env, BEER);
    await propose(env, TAG);
    expect(audit.verifyChain()).toEqual({ ok: true, length: 3 });

    expect(audit.tamperForDemo(2)).toBe(2);
    expect(audit.verifyChain()).toEqual({ ok: false, length: 3, brokenAtSeq: 2 });
    expect(audit.get(2)!.envelope.action.amount.amount).not.toBe(3300 + 500);
  });

  it("an empty log can't be tampered with", () => {
    setup();
    expect(() => audit.tamperForDemo()).toThrow(/No audit row/);
  });

  it("default tamper hits the latest row", async () => {
    const env = setup();
    await propose(env, BOOK);
    await propose(env, BEER);
    expect(audit.tamperForDemo()).toBe(2);
    expect(audit.verifyChain()).toMatchObject({ ok: false, brokenAtSeq: 2 });
  });
});
