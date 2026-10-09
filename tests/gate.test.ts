// The gate end to end on the mock Reap adapter: the eight demo-script steps in order, with
// budget and velocity carrying over, then the approval edge cases.

import { describe, expect, it } from "vitest";
import * as audit from "@/lib/safr/audit";
import { committed, getReservation, loadMandate, saveMandate } from "@/lib/safr/controls";
import { assertExecutable, checkoutIdForEnvelope, GateError, recordCheckoutOutcome } from "@/lib/safr/gate";
import { recordToolCall, setAgentStatus } from "@/lib/safr/registry";
import { AGENT_ID, MINUTE, setup } from "./helpers";

describe("demo script, in order", () => {
  it("produces the expected decision at every step", async () => {
    const { gate, quote, reap, clock } = setup();
    const propose = async (sku: string) =>
      gate.proposeCheckout({ quoteId: (await quote(sku)).id, reason: `buy ${sku}`, sessionId: "demo" });

    // Every checkout call must find its audit entry already written.
    const createCheckout = reap.createCheckout.bind(reap);
    reap.createCheckout = async (input) => {
      expect(audit.latestForEnvelope(input.idempotencyKey)).not.toBeNull();
      return createCheckout(input);
    };

    // 1. ghost-stories book S$10.79 (+S$5 shipping) → AUTO_EXECUTE, checkout created
    recordToolCall({ sessionId: "demo", agentId: AGENT_ID, tool: "listCatalog", allowed: true });
    recordToolCall({ sessionId: "demo", agentId: AGENT_ID, tool: "getQuote", allowed: true });
    const book = await propose("popular-ghost-stories-12");
    expect(book).toMatchObject({ decision: "AUTO_EXECUTE", checkoutId: expect.any(String), approvalUrl: expect.any(String) });
    expect(book.message).toContain("Awaiting your approval on Reap's page");
    expect(audit.latestForEnvelope(book.envelopeHash)).toMatchObject({ executed: true, checkoutId: book.checkoutId });
    expect(audit.latestForEnvelope(book.envelopeHash)!.envelope.context.toolTrace).toEqual(["listCatalog", "getQuote", "proposeCheckout"]);
    expect(checkoutIdForEnvelope(book.envelopeHash)).toBe(book.checkoutId);
    expect(recordCheckoutOutcome(book.checkoutId!, "COMPLETED")?.reservation?.status).toBe("SETTLED");

    // 2. luggage tag S$85 → ESCALATE, then a human approves
    clock.advance(MINUTE);
    const tag = await propose("byndartisan-luggage-tag");
    expect(tag).toMatchObject({ decision: "ESCALATE" });
    expect(tag.checkoutId).toBeUndefined();
    expect(reap.checkoutsCreated()).toBe(1);
    expect(gate.listPendingApprovals()).toMatchObject([{ envelopeHash: tag.envelopeHash, amount: { amount: 9000, currency: "SGD" } }]);
    const approved = await gate.approve(tag.envelopeHash, "terence");
    expect(approved).toMatchObject({ decision: "AUTO_EXECUTE", envelopeHash: tag.envelopeHash, checkoutId: expect.any(String) });
    expect(audit.latestForEnvelope(tag.envelopeHash)!.disposition.rulesFired).toEqual(["OVER_AUTO_THRESHOLD", "HUMAN_APPROVED"]);
    await expect(gate.approve(tag.envelopeHash, "terence")).rejects.toMatchObject({ status: 409 });
    expect(gate.listPendingApprovals()).toEqual([]);

    // 3. custom table S$699 → DENY hard cap
    const table = await propose("picketandrail-geometry-table");
    expect(table).toMatchObject({ decision: "DENY" });
    expect(audit.latestForEnvelope(table.envelopeHash)!.disposition.rulesFired).toEqual(["OVER_HARD_CAP"]);

    // 4. laptop stand US$58 → DENY currency mismatch
    const stand = await propose("zmdesktop-laptop-stand");
    expect(audit.latestForEnvelope(stand.envelopeHash)!.disposition.rulesFired).toEqual(["CURRENCY_MISMATCH"]);

    // 5. beer S$33 → DENY category
    const beer = await propose("brewlander-6pack");
    expect(audit.latestForEnvelope(beer.envelopeHash)!.disposition.rulesFired).toEqual(["CATEGORY_OUT_OF_SCOPE"]);
    expect(reap.checkoutsCreated()).toBe(2); // no Reap call for any DENY

    // 6. book again within 5 min → OBSERVE, still executes
    clock.advance(MINUTE);
    const again = await propose("popular-ghost-stories-12");
    expect(again).toMatchObject({ decision: "OBSERVE", checkoutId: expect.any(String) });
    expect(committed("mandate-001")).toEqual({ settled: 1579, reserved: 9000 + 1579 });

    // 7. revoke agent → DENY at identity; nothing reserved, nothing sent to Reap
    setAgentStatus(AGENT_ID, "REVOKED");
    const revoked = await propose("ergotune-pegboard");
    expect(revoked).toMatchObject({ decision: "DENY" });
    expect(audit.latestForEnvelope(revoked.envelopeHash)!.disposition.rulesFired).toEqual(["IDENTITY_REVOKED"]);
    expect(getReservation(revoked.envelopeHash)).toBeNull();
    expect(reap.checkoutsCreated()).toBe(3);

    // 8. tamper an audit row → chain badge red
    expect(audit.verifyChain()).toEqual({ ok: true, length: 8 });
    audit.tamperForDemo(1);
    expect(audit.verifyChain()).toEqual({ ok: false, length: 8, brokenAtSeq: 1 });
  });
});

describe("gate", () => {
  it("denies over the remaining budget once earlier purchases are counted", async () => {
    const { gate, quote } = setup();
    await gate.proposeCheckout({ quoteId: (await quote("byndartisan-luggage-tag")).id, reason: "", sessionId: "s" });
    const pegboard = await gate.proposeCheckout({ quoteId: (await quote("ergotune-pegboard", 2)).id, reason: "", sessionId: "s" });
    // 15000 − 9000 held for the tag = 6000 left; two pegboards are 12300
    expect(audit.latestForEnvelope(pegboard.envelopeHash)!.disposition.rulesFired).toEqual(["OVER_REMAINING_BUDGET"]);
    expect(audit.latestForEnvelope(pegboard.envelopeHash)!.envelope.action.items).toEqual([{ sku: "ergotune-pegboard", quantity: 2 }]);
  });

  it("decline releases the hold and logs HUMAN_DECLINED", async () => {
    const { gate, quote } = setup();
    const tag = await gate.proposeCheckout({ quoteId: (await quote("byndartisan-luggage-tag")).id, reason: "", sessionId: "s" });
    expect(committed("mandate-001").reserved).toBe(9000);
    expect(await gate.decline(tag.envelopeHash, "terence")).toMatchObject({ decision: "DENY" });
    expect(committed("mandate-001").reserved).toBe(0);
    expect(audit.latestForEnvelope(tag.envelopeHash)!.disposition.rulesFired).toEqual(["HUMAN_DECLINED"]);
    await expect(gate.approve(tag.envelopeHash, "terence")).rejects.toBeInstanceOf(GateError);
  });

  it("an unanswered escalation expires after 5 minutes", async () => {
    const { gate, quote, clock } = setup();
    const tag = await gate.proposeCheckout({ quoteId: (await quote("byndartisan-luggage-tag")).id, reason: "", sessionId: "s" });
    clock.advance(5 * MINUTE);
    expect(gate.listPendingApprovals()).toEqual([]);
    expect(getReservation(tag.envelopeHash)?.status).toBe("RELEASED");
    expect(audit.latestForEnvelope(tag.envelopeHash)!.disposition.rulesFired).toEqual(["APPROVAL_TIMEOUT"]);
    await expect(gate.approve(tag.envelopeHash, "terence")).rejects.toMatchObject({ status: 409 });
  });

  it("approval only works for an escalated envelope; a cleared one can't be 'approved' again", async () => {
    const { gate, quote } = setup();
    const book = await gate.proposeCheckout({ quoteId: (await quote("popular-ghost-stories-12")).id, reason: "", sessionId: "s" });
    await expect(gate.approve(book.envelopeHash, "terence")).rejects.toMatchObject({ status: 404 });
    await expect(gate.approve("f".repeat(64), "terence")).rejects.toMatchObject({ status: 404 });
  });

  it("approval re-checks every rule: revoked in the meantime → DENY and release", async () => {
    const { gate, quote, reap } = setup();
    const tag = await gate.proposeCheckout({ quoteId: (await quote("byndartisan-luggage-tag")).id, reason: "", sessionId: "s" });
    setAgentStatus(AGENT_ID, "REVOKED");
    const result = await gate.approve(tag.envelopeHash, "terence");
    expect(result.decision).toBe("DENY");
    expect(result.message).toContain("revoked");
    expect(getReservation(tag.envelopeHash)?.status).toBe("RELEASED");
    expect(reap.checkoutsCreated()).toBe(0);
  });

  it("approval after the quote expired re-quotes, re-signs and executes the new envelope", async () => {
    const { gate, quote, reap, clock } = setup();
    const q = await quote("byndartisan-luggage-tag");
    const tag = await gate.proposeCheckout({ quoteId: q.id, reason: "", sessionId: "s" });
    clock.advance(MINUTE);
    reap.expireQuote(q.id);
    const result = await gate.approve(tag.envelopeHash, "terence");
    expect(result).toMatchObject({ decision: "AUTO_EXECUTE", checkoutId: expect.any(String) });
    expect(result.envelopeHash).not.toBe(tag.envelopeHash);
    expect(getReservation(tag.envelopeHash)?.status).toBe("RELEASED");
    expect(getReservation(result.envelopeHash)?.status).toBe("RESERVED");
    expect(audit.latestForEnvelope(result.envelopeHash)!.envelope.action.quoteId).not.toBe(q.id);
    expect(audit.verifyChain().ok).toBe(true);
  });

  it("a mandate edit between escalation and approval is applied (kill switch → DENY)", async () => {
    const { gate, quote } = setup();
    const tag = await gate.proposeCheckout({ quoteId: (await quote("byndartisan-luggage-tag")).id, reason: "", sessionId: "s" });
    saveMandate({ ...loadMandate(), killSwitch: true });
    const result = await gate.approve(tag.envelopeHash, "terence");
    expect(result.decision).toBe("DENY");
    expect(audit.latestForEnvelope(result.envelopeHash)!.disposition.rulesFired).toEqual(["KILL_SWITCH"]);
  });

  it("no private key → unsigned envelope → DENY at identity, still audited", async () => {
    const { gate, quote } = setup({ privateKey: null });
    const book = await gate.proposeCheckout({ quoteId: (await quote("popular-ghost-stories-12")).id, reason: "", sessionId: "s" });
    expect(book.decision).toBe("DENY");
    expect(book.message).toContain("npm run keygen");
    expect(audit.list()).toHaveLength(1);
  });

  it("unknown quote → DENY without an envelope", async () => {
    const { gate } = setup();
    expect(await gate.proposeCheckout({ quoteId: "nope", reason: "", sessionId: "s" })).toMatchObject({ decision: "DENY", envelopeHash: "" });
    expect(audit.list()).toHaveLength(0);
  });

  it("Reap checkout failure after a cleared decision releases the hold", async () => {
    const { gate, quote, reap } = setup();
    reap.createCheckout = async () => {
      throw new Error("enrollment not ACTIVE");
    };
    const book = await gate.proposeCheckout({ quoteId: (await quote("popular-ghost-stories-12")).id, reason: "", sessionId: "s" });
    expect(book.decision).toBe("AUTO_EXECUTE");
    expect(book.checkoutId).toBeUndefined();
    expect(book.message).toContain("nothing was charged");
    expect(getReservation(book.envelopeHash)?.status).toBe("RELEASED");
  });

  it("assertExecutable only passes a cleared envelope for its own quote", async () => {
    const { gate, quote } = setup();
    const q = await quote("popular-ghost-stories-12");
    const book = await gate.proposeCheckout({ quoteId: q.id, reason: "", sessionId: "s" });
    expect(assertExecutable(book.envelopeHash, q.id)).toBe(true);
    expect(assertExecutable(book.envelopeHash, "another-quote")).toBe(false);
    const beer = await gate.proposeCheckout({ quoteId: (await quote("brewlander-6pack")).id, reason: "", sessionId: "s" });
    expect(assertExecutable(beer.envelopeHash, "anything")).toBe(false);
  });
});
