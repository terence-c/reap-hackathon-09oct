// Disposition Engine, pure: hand-made fake quotes, no DB, no Reap. Covers the six gate decisions
// in the demo script plus revoked agent, tampered signature and kill switch.

import { describe, expect, it } from "vitest";
import demoMandate from "@/lib/mandate.demo.json";
import type { Envelope, Mandate, Quote } from "@/lib/types";
import { checkIdentity, dispose, formatMoney, type TrustedContext } from "@/lib/safr/disposition";
import { buildEnvelope, generateAgentKeyPair, hashEnvelope, signEnvelope, verifyEnvelope } from "@/lib/safr/envelope";
import type { AgentRecord } from "@/lib/safr/registry";
import { fakeQuote, item, START } from "./helpers";

const mandate = demoMandate as Mandate;
const keys = generateAgentKeyPair();
const agent: AgentRecord = {
  agentId: "purchasing-agent-v1",
  displayName: "AgentCart purchasing agent",
  owner: "team-agentcart",
  model: "test-model",
  promptHash: "unregistered",
  allowedTools: ["listCatalog", "getQuote", "proposeCheckout"],
  allowedActionTypes: ["CREATE_CHECKOUT"],
  principals: ["demo-user-001"],
  publicKey: keys.publicKey,
  publicKeyFingerprint: null,
  status: "ACTIVE",
  updatedAt: new Date(START).toISOString(),
};

function envelopeFor(sku: string, quote: Quote = fakeQuote(sku), privateKey = keys.privateKey): Envelope {
  const unsigned = buildEnvelope({
    quote,
    catalogItem: item(sku),
    quantity: 1,
    mandate,
    agent: { agentId: agent.agentId, model: agent.model, promptHash: agent.promptHash },
    sessionId: "s1",
    toolTrace: ["listCatalog", "getQuote", "proposeCheckout"],
    agentReason: "test",
  });
  return signEnvelope(unsigned, privateKey);
}

function ctx(sku: string, overrides: Partial<TrustedContext> = {}): TrustedContext {
  const envelope = overrides.envelope ?? envelopeFor(sku);
  const a = overrides.agent === undefined ? agent : overrides.agent;
  return {
    envelope,
    agent: a,
    signature: verifyEnvelope(envelope, a?.publicKey),
    mandate,
    now: START,
    listedCurrency: item(sku).unitPrice.currency,
    remainingBudget: mandate.totalBudget,
    recentPurchaseCount: 0,
    ...overrides,
  };
}

describe("demo script decisions", () => {
  it("ghost-stories book S$10.79 (+S$5 shipping) → AUTO_EXECUTE", () => {
    const d = dispose(ctx("popular-ghost-stories-12"));
    expect(d.decision).toBe("AUTO_EXECUTE");
    expect(d.rulesFired).toEqual([]);
    expect(d.reason).toContain("S$15.79");
  });

  it("luggage tag S$85 → ESCALATE (over the S$80 auto threshold)", () => {
    const d = dispose(ctx("byndartisan-luggage-tag"));
    expect(d).toMatchObject({ decision: "ESCALATE", rulesFired: ["OVER_AUTO_THRESHOLD"] });
    expect(d.reason).toContain("S$80.00");
  });

  it("custom table S$699 → DENY OVER_HARD_CAP", () => {
    expect(dispose(ctx("picketandrail-geometry-table"))).toMatchObject({ decision: "DENY", rulesFired: ["OVER_HARD_CAP"] });
  });

  it("laptop stand US$58 → DENY CURRENCY_MISMATCH", () => {
    const d = dispose(ctx("zmdesktop-laptop-stand"));
    expect(d).toMatchObject({ decision: "DENY", rulesFired: ["CURRENCY_MISMATCH"] });
    expect(d.reason).toContain("USD");
  });

  it("laptop stand still DENY CURRENCY_MISMATCH if Reap quotes it converted to SGD", () => {
    const quote = fakeQuote("zmdesktop-laptop-stand", { finalAmount: { amount: 7900, currency: "SGD" } });
    const envelope = envelopeFor("zmdesktop-laptop-stand", quote);
    expect(dispose(ctx("zmdesktop-laptop-stand", { envelope })).rulesFired).toEqual(["CURRENCY_MISMATCH"]);
  });

  it("beer S$33 → DENY CATEGORY_OUT_OF_SCOPE", () => {
    const d = dispose(ctx("brewlander-6pack"));
    expect(d).toMatchObject({ decision: "DENY", rulesFired: ["CATEGORY_OUT_OF_SCOPE"] });
    expect(d.reason).toContain("Drinks & Alcohol");
  });

  it("book again within 5 min → OBSERVE VELOCITY", () => {
    const d = dispose(ctx("popular-ghost-stories-12", { recentPurchaseCount: 1, remainingBudget: 4421 }));
    expect(d).toMatchObject({ decision: "OBSERVE", rulesFired: ["VELOCITY"] });
  });
});

describe("identity", () => {
  it("revoked agent → DENY IDENTITY_REVOKED", () => {
    const d = dispose(ctx("popular-ghost-stories-12", { agent: { ...agent, status: "REVOKED" } }));
    expect(d).toMatchObject({ decision: "DENY", rulesFired: ["IDENTITY_REVOKED"] });
  });

  it("tampered envelope (amount edited after signing) → DENY IDENTITY_BAD_SIGNATURE", () => {
    const envelope = envelopeFor("popular-ghost-stories-12");
    const tampered: Envelope = { ...envelope, action: { ...envelope.action, amount: { amount: 1, currency: "SGD" } } };
    expect(dispose(ctx("popular-ghost-stories-12", { envelope: tampered }))).toMatchObject({
      decision: "DENY",
      rulesFired: ["IDENTITY_BAD_SIGNATURE"],
    });
  });

  it("re-hashed but signed by a different key → DENY IDENTITY_BAD_SIGNATURE", () => {
    const envelope = envelopeFor("popular-ghost-stories-12", undefined, generateAgentKeyPair().privateKey);
    expect(hashEnvelope(envelope)).toBe(envelope.hash);
    expect(dispose(ctx("popular-ghost-stories-12", { envelope })).rulesFired).toEqual(["IDENTITY_BAD_SIGNATURE"]);
  });

  it("unsigned envelope or no registered public key → DENY IDENTITY_BAD_SIGNATURE", () => {
    const unsigned = envelopeFor("popular-ghost-stories-12", undefined, "");
    expect(dispose(ctx("popular-ghost-stories-12", { envelope: unsigned })).rulesFired).toEqual(["IDENTITY_BAD_SIGNATURE"]);
    expect(dispose(ctx("popular-ghost-stories-12", { agent: { ...agent, publicKey: null } })).rulesFired).toEqual([
      "IDENTITY_BAD_SIGNATURE",
    ]);
  });

  it("unknown agent → DENY IDENTITY_UNKNOWN_AGENT", () => {
    expect(dispose(ctx("popular-ghost-stories-12", { agent: null })).rulesFired).toEqual(["IDENTITY_UNKNOWN_AGENT"]);
  });

  it("principal the agent doesn't act for → DENY IDENTITY_PRINCIPAL_NOT_ALLOWED", () => {
    const d = dispose(ctx("popular-ghost-stories-12", { agent: { ...agent, principals: ["someone-else"] } }));
    expect(d.rulesFired).toEqual(["IDENTITY_PRINCIPAL_NOT_ALLOWED"]);
  });

  it("checkIdentity passes a valid, active, signed envelope", () => {
    expect(checkIdentity(ctx("popular-ghost-stories-12"))).toBeNull();
  });
});

describe("controls", () => {
  it("kill switch → DENY KILL_SWITCH, and it outranks later rules", () => {
    const d = dispose(ctx("brewlander-6pack", { mandate: { ...mandate, killSwitch: true } }));
    expect(d).toMatchObject({ decision: "DENY", rulesFired: ["KILL_SWITCH"] });
  });

  it("identity outranks the kill switch", () => {
    const d = dispose(ctx("popular-ghost-stories-12", { agent: { ...agent, status: "REVOKED" }, mandate: { ...mandate, killSwitch: true } }));
    expect(d.rulesFired).toEqual(["IDENTITY_REVOKED"]);
  });

  it("outside the mandate's validity window → DENY MANDATE_EXPIRED", () => {
    const d = dispose(ctx("popular-ghost-stories-12", { now: Date.parse("2026-10-11T00:00:01+08:00") }));
    expect(d.rulesFired).toEqual(["MANDATE_EXPIRED"]);
  });

  it("expired quote → DENY QUOTE_EXPIRED", () => {
    expect(dispose(ctx("popular-ghost-stories-12", { now: START + 11 * 60_000 })).rulesFired).toEqual(["QUOTE_EXPIRED"]);
  });

  it("merchant not on an allowlist → DENY MERCHANT_NOT_ALLOWED", () => {
    const d = dispose(ctx("popular-ghost-stories-12", { mandate: { ...mandate, allowedMerchants: ["ergotune.com"] } }));
    expect(d.rulesFired).toEqual(["MERCHANT_NOT_ALLOWED"]);
  });

  it("over what's left of the budget → DENY OVER_REMAINING_BUDGET", () => {
    const d = dispose(ctx("ergotune-pegboard", { remainingBudget: 2842 }));
    expect(d).toMatchObject({ decision: "DENY", rulesFired: ["OVER_REMAINING_BUDGET"] });
    expect(d.reason).toContain("S$28.42");
  });

  it("escalation and velocity both fire → ESCALATE with both rules", () => {
    const d = dispose(ctx("byndartisan-luggage-tag", { recentPurchaseCount: 2 }));
    expect(d).toMatchObject({ decision: "ESCALATE", rulesFired: ["OVER_AUTO_THRESHOLD", "VELOCITY"] });
  });

  it("amount exactly at the threshold auto-executes", () => {
    const quote = fakeQuote("ergotune-pegboard", { finalAmount: { amount: 8000, currency: "SGD" } });
    expect(dispose(ctx("ergotune-pegboard", { envelope: envelopeFor("ergotune-pegboard", quote) })).decision).toBe("AUTO_EXECUTE");
  });
});

it("formatMoney", () => {
  expect(formatMoney({ amount: 1079, currency: "SGD" })).toBe("S$10.79");
  expect(formatMoney({ amount: 5800, currency: "USD" })).toBe("US$58.00");
});
