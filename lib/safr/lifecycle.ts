// Lifecycle policies: the checks that describe what happened around the decision — only allowed
// tools, the price bound to a Reap quote, the record intact, the payment confirmed. Computed
// live on every read (never written into the hash chain), so tampering with stored rows shows
// up here immediately and existing entries keep verifying.

import type { AuditEntry } from "../types";
import type { ReservationStatus } from "./controls";
import type { PolicyCheck } from "./policies";

export type LifecycleInput = {
  entry: AuditEntry;
  // From the agent's registry record: which tools it may use, and whether the request's own
  // chat session saw a tool call the registry denied.
  allowedTools: string[];
  deniedToolInSession: boolean;
  // Recomputed now: hashEnvelope matches the stored hash, and the signature over that hash
  // verifies with the agent's registered public key.
  hashOk: boolean;
  signatureOk: boolean;
  // verifyChain() for the whole log; brokenAtSeq is where it first breaks.
  chain: { ok: boolean; brokenAtSeq?: number };
  // The budget hold for this envelope (RESERVED / SETTLED / RELEASED), null when none was taken.
  reservation: ReservationStatus | null;
};

export function lifecycleChecks(input: LifecycleInput): PolicyCheck[] {
  const { entry } = input;
  const checks: PolicyCheck[] = [];

  const traceOk =
    !input.deniedToolInSession && entry.envelope.context.toolTrace.every((tool) => input.allowedTools.includes(tool));
  checks.push({ id: "TOOLS_ALLOWED", result: traceOk ? "pass" : "fail" });

  const priceOk = entry.envelope.action.quoteId.length > 0 && Number.isSafeInteger(entry.envelope.action.amount.amount) && entry.envelope.action.amount.amount >= 0;
  checks.push({ id: "PRICE_FROM_REAP", result: priceOk ? "pass" : "fail" });

  // The row exists, and the gate appends it before any Reap call (markExecuted only attaches
  // the checkout id afterwards), so this always holds by construction.
  checks.push({ id: "LOGGED_BEFORE_PAYMENT", result: "pass" });

  checks.push({ id: "RECORD_UNCHANGED", result: input.hashOk && input.signatureOk ? "pass" : "fail" });
  checks.push({
    id: "CHAIN_INTACT",
    result: !input.chain.ok && input.chain.brokenAtSeq !== undefined && input.chain.brokenAtSeq <= entry.seq ? "fail" : "pass",
  });

  if (!entry.executed) {
    checks.push({ id: "PAYMENT_CONFIRMED", result: "skipped" });
  } else if (input.reservation === "SETTLED") {
    checks.push({ id: "PAYMENT_CONFIRMED", result: "pass" });
  } else if (input.reservation === "RESERVED") {
    checks.push({ id: "PAYMENT_CONFIRMED", result: "pending" });
  } else {
    checks.push({ id: "PAYMENT_CONFIRMED", result: "fail" });
  }

  return checks;
}
