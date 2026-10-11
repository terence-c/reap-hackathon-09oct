// REAP_MODE=mock: the recorded-sandbox adapter. No REAP_API_KEY, and any network call fails the test.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import catalogJson from "@/lib/catalog.json";
import { env } from "@/lib/env";
import { reapAdapter, reapMode } from "@/lib/reap";
import {
  activeEnrollmentId,
  createEnrollment,
  currentEnrollment,
  MOCK_ENROLLMENT_ID,
  refreshPendingEnrollments,
  rememberEnrollment,
} from "@/lib/reap/enrollments";
import { lookupQuote } from "@/lib/reap/quote-store";
import { QUOTE_TTL_MS, RECORDED_QUOTES, recordedReapAdapter, resetRecordedReap } from "@/lib/reap/recorded";
import * as audit from "@/lib/safr/audit";
import { getReservation } from "@/lib/safr/controls";
import { openInMemoryDb } from "@/lib/safr/db";
import { generateAgentKeyPair } from "@/lib/safr/envelope";
import { createGate, recordCheckoutOutcome } from "@/lib/safr/gate";
import { registerPublicKey } from "@/lib/safr/registry";
import type { CatalogItem } from "@/lib/types";
import { DEMO_SHIPPING_ADDRESS } from "@/lib/reap/quotes";

vi.hoisted(() => {
  process.env.REAP_MODE = "mock";
  delete process.env.REAP_API_KEY; // mock mode must not need it
  delete process.env.REAP_ENROLLMENT_ID;
});

// Don't leak mock mode into other test files that share this worker process.
afterAll(() => {
  delete process.env.REAP_MODE;
});

const START = Date.parse("2026-10-09T12:00:00+08:00");
const catalog = catalogJson as CatalogItem[];
const item = (sku: string) => catalog.find((i) => i.sku === sku)!;
const quote = (sku: string, quantity = 1) =>
  reapAdapter.createQuote({ item: item(sku), quantity, email: "demo@example.com", shippingAddress: DEMO_SHIPPING_ADDRESS });

let fetchMock: Mock;

beforeEach(() => {
  openInMemoryDb();
  resetRecordedReap();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  fetchMock = vi.fn(async () => {
    throw new Error("REAP_MODE=mock must not use the network");
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  expect(fetchMock).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("mode selection", () => {
  it("REAP_MODE=mock selects the recorded adapter, without REAP_API_KEY", () => {
    expect(env.REAP_MODE).toBe("mock");
    expect(reapMode()).toBe("mock");
    expect(reapAdapter).toBe(recordedReapAdapter);
    expect(() => env.REAP_API_KEY).toThrow(/REAP_API_KEY/); // really unset
  });
});

describe("recorded quotes", () => {
  it.each([
    ["popular-ghost-stories-12", 1079, 490, 0, 1569],
    ["kinokuniya-conan-106", 940, 480, 118, 1420],
    ["ergotune-pegboard", 5900, 0, 487, 5900],
    ["boxgreen-snack-bag", 4500, 0, 405, 4905],
    ["byndartisan-luggage-tag", 8500, 0, 702, 8500],
    ["picketandrail-geometry-table", 69900, 0, 5772, 69900],
    ["zmdesktop-laptop-stand", 7600, 0, 0, 7600],
    ["brewlander-6pack", 3300, 0, 0, 3300],
  ])("%s quotes the recorded sandbox amounts in SGD cents", async (sku, subtotal, shipping, tax, final) => {
    const q = await quote(sku);
    const sgd = (amount: number) => ({ amount, currency: "SGD" });
    expect(q).toEqual({
      id: expect.stringMatching(/^mock_quote_[0-9a-f-]{36}$/),
      merchantDomain: item(sku).merchantDomain,
      itemsSubtotal: sgd(subtotal),
      shipping: sgd(shipping),
      tax: sgd(tax),
      finalAmount: sgd(final),
      expiresAt: new Date(START + QUOTE_TTL_MS).toISOString(),
    });
    expect(Number.isInteger(q.finalAmount.amount)).toBe(true);
    expect(lookupQuote(q.id)).toEqual({ merchantDomain: item(sku).merchantDomain, sku, quantity: 1 });
    expect(await reapAdapter.getQuote(q.id)).toEqual(q);
  });

  it("every catalog item has a recorded quote", () => {
    expect(Object.keys(RECORDED_QUOTES).sort()).toEqual(catalog.map((i) => i.sku).sort());
  });

  it("quantity scales subtotal, tax and the item part of the total; shipping stays", async () => {
    expect(await quote("popular-ghost-stories-12", 2)).toMatchObject({
      itemsSubtotal: { amount: 2158 },
      shipping: { amount: 490 },
      tax: { amount: 0 },
      finalAmount: { amount: 2648 }, // 2 × 1079 + 490
    });
    expect(await quote("boxgreen-snack-bag", 3)).toMatchObject({
      itemsSubtotal: { amount: 13500 },
      tax: { amount: 1215 },
      finalAmount: { amount: 14715 },
    });
    await expect(quote("popular-ghost-stories-12", 0)).rejects.toThrow(/positive integer/);
  });

  it("getQuote behaves like live: unknown quote ids are refused", async () => {
    await expect(reapAdapter.getQuote("mock_quote_unknown")).rejects.toThrow(/not created by this app/);
  });
});

describe("recorded checkouts", () => {
  const input = (quoteId: string, idempotencyKey: string) => ({
    quoteId,
    enrollmentId: MOCK_ENROLLMENT_ID,
    returnUrl: "http://localhost:3000/orders/done", // offline: http is fine, nothing is sent
    idempotencyKey,
  });

  it("COMPLETED at once with a MOCK- order id and the quote's total; no hosted approval step", async () => {
    const q = await quote("popular-ghost-stories-12");
    const checkout = await reapAdapter.createCheckout(input(q.id, "k1"));
    expect(checkout).toEqual({
      id: expect.stringMatching(/^mock_checkout_[0-9a-f-]{36}$/),
      status: "COMPLETED",
      orderId: expect.stringMatching(/^MOCK-[0-9A-F]{8}$/),
      finalAmount: { amount: 1569, currency: "SGD" },
    });
    expect(checkout.nextAction).toBeUndefined();
    expect(await reapAdapter.getCheckout(checkout.id)).toEqual(checkout);
    expect(await reapAdapter.pollCheckout(checkout.id)).toEqual(checkout);
  });

  it("is idempotent per Idempotency-Key", async () => {
    const q = await quote("popular-ghost-stories-12");
    const first = await reapAdapter.createCheckout(input(q.id, "same-key"));
    const again = await reapAdapter.createCheckout(input(q.id, "same-key"));
    const other = await reapAdapter.createCheckout(input(q.id, "other-key"));
    expect(again).toEqual(first);
    expect(other.id).not.toBe(first.id);
  });

  it("refuses an unknown or expired quote, and an unknown checkout", async () => {
    await expect(reapAdapter.createCheckout(input("mock_quote_nope", "k"))).rejects.toMatchObject({ code: "QUOTE_NOT_FOUND" });
    const q = await quote("popular-ghost-stories-12");
    vi.setSystemTime(START + QUOTE_TTL_MS);
    await expect(reapAdapter.createCheckout(input(q.id, "k2"))).rejects.toMatchObject({ code: "QUOTE_EXPIRED" });
    await expect(reapAdapter.getCheckout("mock_checkout_nope")).rejects.toMatchObject({ status: 404, code: "CHECKOUT_NOT_FOUND" });
  });

  it("the store is shared across separate module instances (Next bundles each route on its own)", async () => {
    const q = await quote("byndartisan-luggage-tag");
    const checkout = await reapAdapter.createCheckout(input(q.id, "k-shared"));

    vi.resetModules();
    const second = await import("@/lib/reap/recorded");
    expect(second.recordedReapAdapter).not.toBe(recordedReapAdapter); // really another instance
    expect(await second.recordedReapAdapter.getQuote(q.id)).toEqual(q);
    expect(await second.recordedReapAdapter.getCheckout(checkout.id)).toEqual(checkout);
    expect(await second.recordedReapAdapter.createCheckout(input(q.id, "k-shared"))).toEqual(checkout);
  });
});

describe("enrollment in mock mode", () => {
  it("with no card stored, the gate charges the mock enrollment", () => {
    expect(activeEnrollmentId()).toBe(MOCK_ENROLLMENT_ID);
    rememberEnrollment({ id: "enr_real", status: "ACTIVE" }, "demo-user-001");
    expect(activeEnrollmentId()).toBe("enr_real");
  });

  it("Add card stores an ACTIVE enrollment at once, with no hosted page; nothing is refreshed from Reap", async () => {
    rememberEnrollment({ id: "enr_pending", status: "REQUIRES_ACTION", url: "https://reap.example/card" }, "demo-user-001");
    const created = await createEnrollment({ ownerId: "demo-user-001", email: "demo@example.com", returnUrl: "http://localhost:3000/x" });
    expect(created).toMatchObject({ id: expect.stringMatching(/^mock-enrollment-/), status: "ACTIVE" });
    expect(created.url).toBeUndefined();
    expect(currentEnrollment()?.id).toBe(created.id);
    await refreshPendingEnrollments();
    expect(activeEnrollmentId()).toBe(created.id);
  });
});

describe("gate end to end in mock mode", () => {
  function mockGate() {
    const keys = generateAgentKeyPair();
    registerPublicKey("purchasing-agent-v1", keys.publicKey);
    // Default enrollmentId, appBaseUrl, simulateWithoutCard: what the app itself uses.
    return createGate({ reap: reapAdapter, agentId: "purchasing-agent-v1", privateKey: () => keys.privateKey });
  }

  async function propose(gate: ReturnType<typeof mockGate>, sku: string) {
    const q = await quote(sku);
    return gate.proposeCheckout({ quoteId: q.id, reason: `buy ${sku}`, sessionId: "mock" });
  }

  it("book → AUTO_EXECUTE, checkout COMPLETED; settling records the spend", async () => {
    const gate = mockGate();
    const book = await propose(gate, "popular-ghost-stories-12");
    expect(book).toMatchObject({ decision: "AUTO_EXECUTE", checkoutId: expect.stringMatching(/^mock_checkout_/) });
    expect(book.approvalUrl).toBeUndefined();
    expect(book.message).not.toMatch(/\b(ordered|purchased|completed)\b/i); // only Reap's status may say so
    const checkout = await reapAdapter.getCheckout(book.checkoutId!);
    expect(checkout).toMatchObject({ status: "COMPLETED", orderId: expect.stringMatching(/^MOCK-/), finalAmount: { amount: 1569 } });
    expect(recordCheckoutOutcome(checkout.id, checkout.status)?.reservation?.status).toBe("SETTLED");
  });

  it("beer → DENY CATEGORY_OUT_OF_SCOPE (quoted in mock, unlike the live 503)", async () => {
    const gate = mockGate();
    const beer = await propose(gate, "brewlander-6pack");
    expect(beer.decision).toBe("DENY");
    expect(audit.latestForEnvelope(beer.envelopeHash)!.disposition.rulesFired).toEqual(["CATEGORY_OUT_OF_SCOPE"]);
    expect(getReservation(beer.envelopeHash)).toBeNull();
  });

  it("laptop stand → DENY CURRENCY_MISMATCH although the quote is in SGD (catalog lists USD)", async () => {
    const gate = mockGate();
    const stand = await propose(gate, "zmdesktop-laptop-stand");
    const entry = audit.latestForEnvelope(stand.envelopeHash)!;
    expect(entry.envelope.action.amount).toEqual({ amount: 7600, currency: "SGD" });
    expect(entry.disposition.rulesFired).toEqual(["CURRENCY_MISMATCH"]);
    expect(stand.message).toContain("USD");
  });

  it("luggage tag → ESCALATE, approve → AUTO_EXECUTE HUMAN_APPROVED and COMPLETED", async () => {
    const gate = mockGate();
    const tag = await propose(gate, "byndartisan-luggage-tag");
    expect(tag.decision).toBe("ESCALATE");
    const approved = await gate.approve(tag.envelopeHash, "terence");
    expect(approved).toMatchObject({ decision: "AUTO_EXECUTE", envelopeHash: tag.envelopeHash });
    expect((await reapAdapter.getCheckout(approved.checkoutId!)).status).toBe("COMPLETED");
  });
});
