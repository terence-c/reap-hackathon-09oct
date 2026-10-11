import { describe, expect, it } from "vitest";
import { POLICIES, POLICY_BY_RULE, checksFromRules } from "@/lib/safr/policies";

const resultOf = (checks: ReturnType<typeof checksFromRules>, id: string) => checks.find((c) => c.id === id)?.result;

describe("SAFR policy catalogue", () => {
  it("lists every policy once, with a unique rule code", () => {
    expect(new Set(POLICIES.map((p) => p.id)).size).toBe(POLICIES.length);
    expect(new Set(POLICIES.map((p) => p.rule)).size).toBe(POLICIES.length);
    expect(POLICY_BY_RULE.OVER_HARD_CAP).toBe("WITHIN_TOTAL_BUDGET");
    expect(POLICY_BY_RULE.APPROVAL_TIMEOUT).toBe("HUMAN_APPROVAL");
  });

  it("auto-executed purchase: every check passes, no human approval", () => {
    const checks = checksFromRules("AUTO_EXECUTE", []);
    expect(checks.filter((c) => c.result === "pass")).toHaveLength(POLICIES.length - 1);
    expect(resultOf(checks, "HUMAN_APPROVAL")).toBe("skipped");
  });

  it("deny stops at the failing policy; later ones are not reached", () => {
    const checks = checksFromRules("DENY", ["CATEGORY_OUT_OF_SCOPE"]);
    expect(resultOf(checks, "CURRENCY_ALLOWED")).toBe("pass");
    expect(resultOf(checks, "CATEGORY_ALLOWED")).toBe("fail");
    expect(resultOf(checks, "WITHIN_TOTAL_BUDGET")).toBe("skipped");
    expect(resultOf(checks, "NOT_A_REPEAT")).toBe("skipped");
  });

  it("identity failure skips every control", () => {
    const checks = checksFromRules("DENY", ["IDENTITY_REVOKED"]);
    expect(resultOf(checks, "IDENTITY_REGISTERED")).toBe("pass");
    expect(resultOf(checks, "IDENTITY_ACTIVE")).toBe("fail");
    expect(resultOf(checks, "KILL_SWITCH_OFF")).toBe("skipped");
  });

  it("escalation and repeat purchases are flags, not failures", () => {
    const escalated = checksFromRules("ESCALATE", ["OVER_AUTO_THRESHOLD", "VELOCITY"]);
    expect(resultOf(escalated, "UNDER_AUTO_LIMIT")).toBe("flag");
    expect(resultOf(escalated, "NOT_A_REPEAT")).toBe("flag");
    expect(resultOf(escalated, "WITHIN_BUDGET_LEFT")).toBe("pass");
    const approved = checksFromRules("AUTO_EXECUTE", ["OVER_AUTO_THRESHOLD", "HUMAN_APPROVED"]);
    expect(resultOf(approved, "HUMAN_APPROVAL")).toBe("pass");
    expect(resultOf(approved, "UNDER_AUTO_LIMIT")).toBe("flag");
  });

  it("a person declining, or the approval window running out, fails human oversight", () => {
    expect(resultOf(checksFromRules("DENY", ["HUMAN_DECLINED"]), "HUMAN_APPROVAL")).toBe("fail");
    expect(resultOf(checksFromRules("DENY", ["APPROVAL_TIMEOUT"]), "HUMAN_APPROVAL")).toBe("fail");
    const changed = checksFromRules("DENY", ["QUOTE_CHANGED"]);
    expect(resultOf(changed, "QUOTE_FRESH")).toBe("fail");
    expect(resultOf(changed, "CURRENCY_ALLOWED")).toBe("skipped");
  });
});

describe("checks in the audit log", () => {
  it("are stored with each decision, hashed, and tamper-evident", async () => {
    const { openInMemoryDb, db } = await import("@/lib/safr/db");
    const audit = await import("@/lib/safr/audit");
    const { buildEnvelope, signEnvelope } = await import("@/lib/safr/envelope");
    const demoMandate = (await import("@/lib/mandate.demo.json")).default;
    const { fakeQuote, item } = await import("./helpers");
    openInMemoryDb();
    const envelope = signEnvelope(
      buildEnvelope({
        quote: fakeQuote("brewlander-6pack"),
        catalogItem: item("brewlander-6pack"),
        quantity: 1,
        mandate: demoMandate as never,
        agent: { agentId: "purchasing-agent-v1", model: "m", promptHash: "p" },
        sessionId: "s",
        toolTrace: [],
        agentReason: "",
      }),
      undefined,
    );
    const entry = audit.append({ envelope, disposition: { decision: "DENY", rulesFired: ["CATEGORY_OUT_OF_SCOPE"], reason: "no" } });
    expect(entry.disposition.checks?.find((c) => c.id === "CATEGORY_ALLOWED")?.result).toBe("fail");
    expect(audit.verifyChain().ok).toBe(true);

    // A row written before checks existed (checks_json NULL) still verifies.
    db().prepare(`UPDATE audit SET checks_json = NULL WHERE seq = ?`).run(entry.seq);
    expect(audit.verifyChain().ok).toBe(false); // hash covered the checks
    db().prepare(`UPDATE audit SET checks_json = ? WHERE seq = ?`).run(JSON.stringify(entry.disposition.checks), entry.seq);
    expect(audit.verifyChain().ok).toBe(true);

    // Flipping a single check to "pass" breaks the chain.
    const forged = entry.disposition.checks!.map((c) => (c.id === "CATEGORY_ALLOWED" ? { ...c, result: "pass" } : c));
    db().prepare(`UPDATE audit SET checks_json = ? WHERE seq = ?`).run(JSON.stringify(forged), entry.seq);
    expect(audit.verifyChain()).toMatchObject({ ok: false, brokenAtSeq: entry.seq });
  });
});
