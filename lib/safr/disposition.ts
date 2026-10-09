// SAFR component 3 — Disposition Engine. Pure functions, no I/O: the gate gathers a
// TrustedContext from the envelope, registry, mandate and clock, and this decides.
// Ordered checks; the first DENY wins. The LLM never decides — it can only be told the reason.

import type { Currency, Disposition, Envelope, Mandate, Money } from "../types";
import type { SignatureCheck } from "./envelope";
import type { AgentRecord } from "./registry";

export type IdentityContext = {
  envelope: Envelope;
  agent: AgentRecord | null;
  signature: SignatureCheck;
};

export type TrustedContext = IdentityContext & {
  mandate: Mandate;
  now: number; // epoch ms
  listedCurrency: Currency; // the catalog's price currency for this item
  remainingBudget: number; // cents, mandate currency
  recentPurchaseCount: number; // same merchant, inside the velocity window
};

const SYMBOL: Record<Currency, string> = { SGD: "S$", USD: "US$" };

export function formatMoney(money: Money): string {
  return `${SYMBOL[money.currency]}${(money.amount / 100).toFixed(2)}`;
}

const deny = (rule: string, reason: string): Disposition => ({ decision: "DENY", rulesFired: [rule], reason });

// Step 1, on its own so the gate can stop here without ever reading the Controls Repository.
export function checkIdentity({ envelope, agent, signature }: IdentityContext): Disposition | null {
  if (!agent || agent.agentId !== envelope.agent.agentId)
    return deny("IDENTITY_UNKNOWN_AGENT", `Agent ${envelope.agent.agentId} is not in the registry, so it cannot spend.`);
  if (agent.status !== "ACTIVE")
    return deny("IDENTITY_REVOKED", `Agent ${agent.agentId} has been revoked, so it cannot spend.`);
  if (!signature.ok)
    return deny("IDENTITY_BAD_SIGNATURE", `The request could not be verified as coming from this agent: ${signature.reason}.`);
  if (!agent.allowedActionTypes.includes(envelope.action.type))
    return deny("IDENTITY_ACTION_NOT_ALLOWED", `Agent ${agent.agentId} is not allowed to ${envelope.action.type}.`);
  if (!agent.principals.includes(envelope.principalId))
    return deny("IDENTITY_PRINCIPAL_NOT_ALLOWED", `Agent ${agent.agentId} does not act for ${envelope.principalId}.`);
  return null;
}

export function dispose(ctx: TrustedContext): Disposition {
  const identity = checkIdentity(ctx);
  if (identity) return identity;

  const { envelope, mandate, now } = ctx;
  const { action } = envelope;
  const amount = action.amount;

  if (mandate.killSwitch) return deny("KILL_SWITCH", "The mandate's kill switch is on, so all spending is paused.");

  if (now < Date.parse(mandate.validFrom) || now > Date.parse(mandate.validTo))
    return deny("MANDATE_EXPIRED", "The spending mandate is not valid right now, so this purchase is blocked.");

  if (now >= Date.parse(envelope.context.quoteExpiresAt))
    return deny("QUOTE_EXPIRED", "The quote has expired; get a fresh quote and try again.");

  if (amount.currency !== mandate.currency || ctx.listedCurrency !== mandate.currency) {
    const charged = amount.currency !== mandate.currency ? amount.currency : ctx.listedCurrency;
    return deny(
      "CURRENCY_MISMATCH",
      `${action.merchantDomain} prices in ${charged}, but the mandate only allows ${mandate.currency}, so this purchase is blocked.`,
    );
  }

  if (!mandate.allowedCategories.includes(action.category))
    return deny(
      "CATEGORY_OUT_OF_SCOPE",
      `${action.category} is outside this mandate (allowed: ${mandate.allowedCategories.join(", ")}), so this purchase is blocked.`,
    );

  if (mandate.allowedMerchants && !mandate.allowedMerchants.includes(action.merchantDomain))
    return deny("MERCHANT_NOT_ALLOWED", `${action.merchantDomain} is not on this mandate's merchant list, so this purchase is blocked.`);

  const cap: Money = { amount: mandate.totalBudget, currency: mandate.currency };
  if (amount.amount > mandate.totalBudget)
    return deny("OVER_HARD_CAP", `${formatMoney(amount)} is over the mandate's ${formatMoney(cap)} total budget, so this purchase is blocked.`);

  const left: Money = { amount: Math.max(0, ctx.remainingBudget), currency: mandate.currency };
  if (amount.amount > ctx.remainingBudget)
    return deny(
      "OVER_REMAINING_BUDGET",
      `${formatMoney(amount)} is more than the ${formatMoney(left)} left in this mandate's budget, so this purchase is blocked.`,
    );

  // Non-blocking rules accumulate; the strongest one sets the decision.
  const rulesFired: string[] = [];
  const threshold: Money = { amount: mandate.autoThreshold, currency: mandate.currency };
  const overThreshold = amount.amount > mandate.autoThreshold;
  const repeat = ctx.recentPurchaseCount >= 1;
  if (overThreshold) rulesFired.push("OVER_AUTO_THRESHOLD");
  if (repeat) rulesFired.push("VELOCITY");

  if (overThreshold)
    return {
      decision: "ESCALATE",
      rulesFired,
      reason: `${formatMoney(amount)} is above the ${formatMoney(threshold)} auto-approve limit, so a human must approve it.`,
    };
  if (repeat)
    return {
      decision: "OBSERVE",
      rulesFired,
      reason: `${formatMoney(amount)} is within the mandate, but it is a repeat purchase from ${action.merchantDomain} within 5 minutes, so it goes ahead flagged for review.`,
    };
  return {
    decision: "AUTO_EXECUTE",
    rulesFired,
    reason: `${formatMoney(amount)} is within the mandate and under the ${formatMoney(threshold)} auto-approve limit, so it goes ahead automatically.`,
  };
}
