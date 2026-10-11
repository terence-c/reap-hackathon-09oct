// Every SAFR policy the gate evaluates, in evaluation order, grouped by SAFR component (MAS
// "Safeguards for Agentic Finance at Runtime"). Pure data, safe to import in client components:
// the panel renders this list and ticks each policy off from the latest decision's checks.

export type PolicyComponent = "Agent identity" | "Controls" | "Disposition" | "Human oversight" | "Record keeping" | "Payment";

export type PolicyId =
  | "IDENTITY_REGISTERED"
  | "IDENTITY_ACTIVE"
  | "IDENTITY_SIGNATURE"
  | "IDENTITY_ACTION"
  | "IDENTITY_PRINCIPAL"
  | "KILL_SWITCH_OFF"
  | "MANDATE_IN_EFFECT"
  | "QUOTE_FRESH"
  | "CURRENCY_ALLOWED"
  | "CATEGORY_ALLOWED"
  | "MERCHANT_ALLOWED"
  | "WITHIN_TOTAL_BUDGET"
  | "WITHIN_BUDGET_LEFT"
  | "UNDER_AUTO_LIMIT"
  | "NOT_A_REPEAT"
  | "HUMAN_APPROVAL"
  | "TOOLS_ALLOWED"
  | "PRICE_FROM_REAP"
  | "LOGGED_BEFORE_PAYMENT"
  | "RECORD_UNCHANGED"
  | "CHAIN_INTACT"
  | "PAYMENT_CONFIRMED";

// pass: the policy holds. fail: it blocked the purchase. flag: it did not block, but changed the
// outcome (needs approval / flagged as a repeat). skipped: not reached because an earlier policy
// failed. pending: lifecycle only — decided but not yet confirmed (payment still in flight).
export type PolicyResult = "pass" | "fail" | "flag" | "skipped" | "pending";

export type PolicyCheck = { id: PolicyId; result: PolicyResult };

export type Policy = {
  id: PolicyId;
  component: PolicyComponent;
  title: string; // plain language, shown in the panel
  rule: string; // the rule code(s) the gate records when this policy fails or flags
};

export const POLICIES: readonly Policy[] = [
  { id: "IDENTITY_REGISTERED", component: "Agent identity", title: "Assistant is registered", rule: "IDENTITY_UNKNOWN_AGENT" },
  { id: "IDENTITY_ACTIVE", component: "Agent identity", title: "Assistant is not paused", rule: "IDENTITY_REVOKED" },
  { id: "IDENTITY_SIGNATURE", component: "Agent identity", title: "Request signed with the assistant's key", rule: "IDENTITY_BAD_SIGNATURE" },
  { id: "IDENTITY_ACTION", component: "Agent identity", title: "Assistant may make purchases", rule: "IDENTITY_ACTION_NOT_ALLOWED" },
  { id: "IDENTITY_PRINCIPAL", component: "Agent identity", title: "Assistant acts for this user", rule: "IDENTITY_PRINCIPAL_NOT_ALLOWED" },
  { id: "KILL_SWITCH_OFF", component: "Controls", title: "Spending is not switched off", rule: "KILL_SWITCH" },
  { id: "MANDATE_IN_EFFECT", component: "Controls", title: "Spending limits are in effect today", rule: "MANDATE_EXPIRED" },
  { id: "QUOTE_FRESH", component: "Controls", title: "Price quote is still valid", rule: "QUOTE_EXPIRED" },
  { id: "CURRENCY_ALLOWED", component: "Controls", title: "Priced in the allowed currency", rule: "CURRENCY_MISMATCH" },
  { id: "CATEGORY_ALLOWED", component: "Controls", title: "Item is in an allowed category", rule: "CATEGORY_OUT_OF_SCOPE" },
  { id: "MERCHANT_ALLOWED", component: "Controls", title: "Shop is allowed", rule: "MERCHANT_NOT_ALLOWED" },
  { id: "WITHIN_TOTAL_BUDGET", component: "Controls", title: "Within the total budget", rule: "OVER_HARD_CAP" },
  { id: "WITHIN_BUDGET_LEFT", component: "Controls", title: "Within the budget left", rule: "OVER_REMAINING_BUDGET" },
  { id: "UNDER_AUTO_LIMIT", component: "Disposition", title: "Under the auto-approve limit", rule: "OVER_AUTO_THRESHOLD" },
  { id: "NOT_A_REPEAT", component: "Disposition", title: "Not a repeat purchase from the same shop", rule: "VELOCITY" },
  { id: "HUMAN_APPROVAL", component: "Human oversight", title: "A person approved it", rule: "HUMAN_APPROVED" },
] as const;

// Lifecycle policies: what the purchase does after the decision (logged first, records intact,
// payment confirmed). Computed live on every read — never stored, so they can't be tampered
// with and old audit rows still verify. lib/safr/lifecycle.ts evaluates them.
export type LifecyclePolicy = { id: PolicyId; component: PolicyComponent; title: string };

export const LIFECYCLE_POLICIES: readonly LifecyclePolicy[] = [
  { id: "TOOLS_ALLOWED", component: "Agent identity", title: "Only allowed shopping actions were used" },
  { id: "PRICE_FROM_REAP", component: "Controls", title: "Price taken from Reap's quote, not from the assistant" },
  { id: "LOGGED_BEFORE_PAYMENT", component: "Record keeping", title: "Decision recorded before any payment" },
  { id: "RECORD_UNCHANGED", component: "Record keeping", title: "Purchase details unchanged since signing" },
  { id: "CHAIN_INTACT", component: "Record keeping", title: "Activity records unchanged" },
  { id: "PAYMENT_CONFIRMED", component: "Payment", title: "Reap confirmed the payment" },
] as const;

// The order the checklist shows and ticks off: 16 decision-time policies interleaved with the
// lifecycle ones, in evaluation order.
export const CHECKLIST_ORDER: readonly PolicyId[] = [
  "TOOLS_ALLOWED",
  "IDENTITY_REGISTERED",
  "IDENTITY_ACTIVE",
  "IDENTITY_SIGNATURE",
  "IDENTITY_ACTION",
  "IDENTITY_PRINCIPAL",
  "PRICE_FROM_REAP",
  "KILL_SWITCH_OFF",
  "MANDATE_IN_EFFECT",
  "QUOTE_FRESH",
  "CURRENCY_ALLOWED",
  "CATEGORY_ALLOWED",
  "MERCHANT_ALLOWED",
  "WITHIN_TOTAL_BUDGET",
  "WITHIN_BUDGET_LEFT",
  "UNDER_AUTO_LIMIT",
  "NOT_A_REPEAT",
  "HUMAN_APPROVAL",
  "LOGGED_BEFORE_PAYMENT",
  "RECORD_UNCHANGED",
  "CHAIN_INTACT",
  "PAYMENT_CONFIRMED",
];

// id → display info for every policy (decision-time and lifecycle), for the checklist.
export const POLICY_BY_ID: Readonly<Record<PolicyId, { component: PolicyComponent; title: string }>> = {
  ...Object.fromEntries(POLICIES.map((p) => [p.id, { component: p.component, title: p.title }])),
  ...Object.fromEntries(LIFECYCLE_POLICIES.map((p) => [p.id, { component: p.component, title: p.title }])),
} as Record<PolicyId, { component: PolicyComponent; title: string }>;

// The rule code a policy records when it fails or flags, for mapping old audit rows (no checks
// stored) back onto the checklist. Approval-time outcomes map onto the same policies.
export const POLICY_BY_RULE: Readonly<Record<string, PolicyId>> = {
  ...Object.fromEntries(POLICIES.map((p) => [p.rule, p.id])),
  QUOTE_CHANGED: "QUOTE_FRESH",
  QUOTE_UNAVAILABLE: "QUOTE_FRESH",
  HUMAN_DECLINED: "HUMAN_APPROVAL",
  APPROVAL_TIMEOUT: "HUMAN_APPROVAL",
};

const RULES_FOR: Readonly<Record<PolicyId, string[]>> = POLICIES.reduce(
  (acc, p) => ({ ...acc, [p.id]: Object.entries(POLICY_BY_RULE).filter(([, id]) => id === p.id).map(([rule]) => rule) }),
  {} as Record<PolicyId, string[]>,
);

// Rebuild a checklist from rulesFired alone (for rows written before checks were stored).
export function checksFromRules(decision: "DENY" | "ESCALATE" | "AUTO_EXECUTE" | "OBSERVE", rulesFired: string[]): PolicyCheck[] {
  const fired = new Set(rulesFired);
  let blocked = false;
  return POLICIES.map((p) => {
    if (p.id === "HUMAN_APPROVAL") {
      if (fired.has("HUMAN_APPROVED")) return { id: p.id, result: "pass" };
      if (fired.has("HUMAN_DECLINED") || fired.has("APPROVAL_TIMEOUT")) return { id: p.id, result: "fail" };
      return { id: p.id, result: "skipped" };
    }
    if (blocked) return { id: p.id, result: "skipped" };
    if (RULES_FOR[p.id].some((rule) => fired.has(rule))) {
      if (decision === "DENY" && p.id !== "UNDER_AUTO_LIMIT" && p.id !== "NOT_A_REPEAT") {
        blocked = true;
        return { id: p.id, result: "fail" };
      }
      return { id: p.id, result: "flag" };
    }
    return { id: p.id, result: "pass" };
  });
}
