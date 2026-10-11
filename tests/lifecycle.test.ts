// The lifecycle checklist (lib/safr/lifecycle.ts): the six always-live policies around a
// decision. Every branch, driven by a hand-built audit entry.

import { describe, expect, it } from "vitest";
import { lifecycleChecks, type LifecycleInput } from "@/lib/safr/lifecycle";
import type { AuditEntry } from "@/lib/types";

function entry(overrides: Partial<AuditEntry> = {}, envelope: Record<string, unknown> = {}): AuditEntry {
  return {
    seq: 3,
    ts: "2026-10-09T04:00:00.000Z",
    envelope: {
      envelopeId: "env-1",
      schemaVersion: "1.0",
      agent: { agentId: "a", model: "m", promptHash: "h" },
      principalId: "p",
      sessionId: "s1",
      action: {
        type: "CREATE_CHECKOUT",
        quoteId: "q_1",
        merchantDomain: "shop.sg",
        category: "Books",
        items: [{ sku: "x", quantity: 1 }],
        amount: { amount: 1569, currency: "SGD" },
      },
      context: { mandateId: "m1", mandateVersion: 1, quoteExpiresAt: "2026-10-09T04:10:00.000Z", toolTrace: ["listCatalog", "getQuote", "proposeCheckout"], agentReason: "" },
      hash: "h".repeat(64),
      signature: "sig",
      ...envelope,
    } as AuditEntry["envelope"],
    disposition: { decision: "AUTO_EXECUTE", rulesFired: [], reason: "ok" },
    executed: true,
    checkoutId: "chk_1",
    prevHash: "0".repeat(64),
    hash: "f".repeat(64),
    ...overrides,
  };
}

function input(overrides: Partial<LifecycleInput> = {}): LifecycleInput {
  return {
    entry: entry(),
    allowedTools: ["listCatalog", "getQuote", "proposeCheckout"],
    deniedToolInSession: false,
    hashOk: true,
    signatureOk: true,
    chain: { ok: true },
    reservation: "SETTLED",
    ...overrides,
  };
}

const result = (checks: ReturnType<typeof lifecycleChecks>, id: string) => checks.find((c) => c.id === id)?.result;

describe("lifecycleChecks", () => {
  it("passes everything for a clean, settled purchase", () => {
    const checks = lifecycleChecks(input());
    expect(Object.fromEntries(checks.map((c) => [c.id, c.result]))).toEqual({
      TOOLS_ALLOWED: "pass",
      PRICE_FROM_REAP: "pass",
      LOGGED_BEFORE_PAYMENT: "pass",
      RECORD_UNCHANGED: "pass",
      CHAIN_INTACT: "pass",
      PAYMENT_CONFIRMED: "pass",
    });
  });

  it("TOOLS_ALLOWED fails when the trace used a tool outside the allowlist", () => {
    const bad = entry({}, {});
    bad.envelope.context.toolTrace = ["listCatalog", "deleteEverything"];
    expect(result(lifecycleChecks(input({ entry: bad })), "TOOLS_ALLOWED")).toBe("fail");
    expect(result(lifecycleChecks(input({ entry: bad })), "PAYMENT_CONFIRMED")).toBe("pass");
  });

  it("TOOLS_ALLOWED fails when the session saw a denied tool call", () => {
    expect(result(lifecycleChecks(input({ deniedToolInSession: true })), "TOOLS_ALLOWED")).toBe("fail");
  });

  it("PRICE_FROM_REAP fails without a quote id or with a bad amount", () => {
    const noQuote = entry();
    noQuote.envelope.action.quoteId = "";
    expect(result(lifecycleChecks(input({ entry: noQuote })), "PRICE_FROM_REAP")).toBe("fail");
    const badAmount = entry();
    badAmount.envelope.action.amount.amount = 1.5;
    expect(result(lifecycleChecks(input({ entry: badAmount })), "PRICE_FROM_REAP")).toBe("fail");
  });

  it("RECORD_UNCHANGED fails when the hash or the signature does not verify", () => {
    expect(result(lifecycleChecks(input({ hashOk: false })), "RECORD_UNCHANGED")).toBe("fail");
    expect(result(lifecycleChecks(input({ signatureOk: false })), "RECORD_UNCHANGED")).toBe("fail");
    expect(result(lifecycleChecks(input({ hashOk: false, signatureOk: false })), "RECORD_UNCHANGED")).toBe("fail");
  });

  it("CHAIN_INTACT fails only when the chain breaks at or before this row", () => {
    expect(result(lifecycleChecks(input({ chain: { ok: false, brokenAtSeq: 3 } })), "CHAIN_INTACT")).toBe("fail");
    expect(result(lifecycleChecks(input({ chain: { ok: false, brokenAtSeq: 1 } })), "CHAIN_INTACT")).toBe("fail");
    expect(result(lifecycleChecks(input({ chain: { ok: false, brokenAtSeq: 9 } })), "CHAIN_INTACT")).toBe("pass");
  });

  it("PAYMENT_CONFIRMED is skipped for a decision that never reached Reap", () => {
    const denied = entry({ executed: false, checkoutId: undefined });
    const checks = lifecycleChecks(input({ entry: denied, reservation: null }));
    expect(result(checks, "PAYMENT_CONFIRMED")).toBe("skipped");
    expect(result(checks, "RECORD_UNCHANGED")).toBe("pass");
  });

  it("PAYMENT_CONFIRMED is pending while the hold is RESERVED", () => {
    expect(result(lifecycleChecks(input({ reservation: "RESERVED" })), "PAYMENT_CONFIRMED")).toBe("pending");
  });

  it("PAYMENT_CONFIRMED fails when the hold was released or is missing", () => {
    expect(result(lifecycleChecks(input({ reservation: "RELEASED" })), "PAYMENT_CONFIRMED")).toBe("fail");
    expect(result(lifecycleChecks(input({ reservation: null })), "PAYMENT_CONFIRMED")).toBe("fail");
  });
});
