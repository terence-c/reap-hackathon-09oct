// The SAFR gate: the only path from the agent to Reap's checkout. The agent supplies a quoteId
// and a reason; everything else is re-derived here from Reap, the catalog, the mandate and the
// registry. Order per proposal: read quote → build + sign envelope → identity → controls →
// dispose → audit.append → (only then) Reap checkout.
//
// The checkout is created in-process through the ReapAdapter interface, not over HTTP, so there
// is no public route that could skip the gate. If A keeps app/api/checkout, guard it with
// assertExecutable().

import { z } from "zod";
import catalogJson from "../catalog.json";
import { env } from "../env";
import type {
  CatalogItem,
  CheckoutStatus,
  Disposition,
  Envelope,
  Gate,
  Mandate,
  Money,
  ProposeCheckoutInput,
  ProposeCheckoutResult,
  Quote,
  ReapAdapter,
  ShippingAddress,
} from "../types";
import * as audit from "./audit";
import {
  getReservation,
  loadMandate,
  recentPurchaseCount,
  releaseReservation,
  remainingBudget,
  reserve,
  settle,
  VELOCITY_WINDOW_MS,
} from "./controls";
import { db } from "./db";
import { checkIdentity, dispose, formatMoney } from "./disposition";
import { buildEnvelope, canonicalize, deriveQuantity, findCatalogItem, signEnvelope, verifyEnvelope } from "./envelope";
import { getAgent, toolTraceFor, type AgentRecord } from "./registry";
import { activeEnrollmentId } from "../reap/enrollments";
import { DEMO_SHIPPING_ADDRESS } from "../reap/quotes";
import { reapAdapter } from "./reap-adapter";

export const APPROVAL_WINDOW_MS = 5 * 60 * 1000;

const CatalogSchema = z.array(
  z.object({
    sku: z.string().min(1),
    merchantDomain: z.string().min(1),
    name: z.string(),
    category: z.string().min(1),
    unitPrice: z.object({ amount: z.number().int(), currency: z.enum(["SGD", "USD"]) }),
    checkoutUrl: z.string().url(),
    variantId: z.string(),
  }),
);
export const CATALOG: CatalogItem[] = CatalogSchema.parse(catalogJson);

export { DEMO_SHIPPING_ADDRESS };

const ProposeInputSchema = z.object({
  quoteId: z.string().min(1),
  reason: z.string(),
  sessionId: z.string().min(1),
});

export class GateError extends Error {
  constructor(
    public code: "NOT_FOUND" | "ALREADY_DECIDED",
    public status: 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export type PendingApproval = {
  envelopeHash: string;
  seq: number;
  sessionId: string;
  merchantDomain: string;
  sku: string;
  category: string;
  amount: Money;
  reason: string;
  agentReason: string;
  createdAt: string;
  expiresAt: string;
};

type ApprovalRow = {
  envelope_hash: string;
  audit_seq: number;
  session_id: string;
  status: "PENDING" | "APPROVED" | "DECLINED" | "EXPIRED";
  created_at: number;
  expires_at: number;
};

export type GateDeps = {
  reap: ReapAdapter;
  now?: () => number;
  agentId?: string;
  privateKey?: () => string | undefined;
  enrollmentId?: () => string;
  appBaseUrl?: () => string;
  email?: () => string;
  shippingAddress?: ShippingAddress;
  catalog?: CatalogItem[];
};

export type SafrGate = Gate & {
  approve(envelopeHash: string, reviewer: string): Promise<ProposeCheckoutResult>;
  decline(envelopeHash: string, reviewer: string): Promise<ProposeCheckoutResult>;
  expireStaleApprovals(): number;
  listPendingApprovals(): PendingApproval[];
};

export function createGate(deps: GateDeps): SafrGate {
  const now = deps.now ?? Date.now;
  const agentId = deps.agentId ?? env.AGENT_ID;
  const privateKey = deps.privateKey ?? (() => env.AGENT_PRIVATE_KEY);
  const enrollmentId =
    deps.enrollmentId ??
    (() => {
      const id = activeEnrollmentId();
      if (!id) throw new Error("no card has been added yet. Add one with \"Add card\" in the app");
      return id;
    });
  const appBaseUrl = deps.appBaseUrl ?? (() => env.APP_BASE_URL);
  const email = deps.email ?? (() => env.DEMO_EMAIL);
  const shippingAddress = deps.shippingAddress ?? DEMO_SHIPPING_ADDRESS;
  const catalog = deps.catalog ?? CATALOG;

  function sealEnvelope(quote: Quote, mandate: Mandate, sessionId: string, toolTrace: string[], agentReason: string) {
    const agent = getAgent(agentId);
    const item = findCatalogItem(catalog, quote);
    const envelope = signEnvelope(
      buildEnvelope({
        quote,
        catalogItem: item,
        quantity: item ? deriveQuantity(item, quote) : 1,
        mandate,
        agent: { agentId, model: agent?.model ?? env.OPENAI_MODEL, promptHash: agent?.promptHash ?? "unregistered" },
        sessionId,
        toolTrace,
        agentReason,
      }),
      privateKey(),
    );
    return { envelope, agent, item };
  }

  // Identity first; if it fails the Controls Repository is never consulted.
  function decide(
    envelope: Envelope,
    agent: AgentRecord | null,
    item: CatalogItem | undefined,
    mandate: Mandate,
    t: number,
    excludeEnvelopeHash?: string,
  ): Disposition {
    const signature = verifyEnvelope(envelope, agent?.publicKey);
    const identityDenial = checkIdentity({ envelope, agent, signature });
    if (identityDenial) return identityDenial;
    return dispose({
      envelope,
      agent,
      signature,
      mandate,
      now: t,
      listedCurrency: item?.unitPrice.currency ?? envelope.action.amount.currency,
      remainingBudget: remainingBudget(mandate.id, { excludeEnvelopeHash }),
      recentPurchaseCount: recentPurchaseCount(envelope.action.merchantDomain, VELOCITY_WINDOW_MS, t, { excludeEnvelopeHash }),
    });
  }

  // Called only after the audit entry exists. Holds the budget, then asks Reap for a checkout.
  async function execute(envelope: Envelope, seq: number, disposition: Disposition, t: number): Promise<ProposeCheckoutResult> {
    reserve(
      envelope.hash,
      { mandateId: envelope.context.mandateId, merchantDomain: envelope.action.merchantDomain, amount: envelope.action.amount },
      t,
    );
    try {
      const checkout = await deps.reap.createCheckout({
        quoteId: envelope.action.quoteId,
        enrollmentId: enrollmentId(),
        returnUrl: `${appBaseUrl()}/orders/done?envelopeHash=${envelope.hash}`,
        idempotencyKey: envelope.hash,
      });
      audit.markExecuted(seq, checkout.id);
      const next = checkout.nextAction
        ? "Awaiting your approval on Reap's page."
        : "Checkout sent to Reap; waiting for it to confirm.";
      return {
        decision: disposition.decision,
        message: `${disposition.reason} ${next}`,
        approvalUrl: checkout.nextAction?.url,
        checkoutId: checkout.id,
        envelopeHash: envelope.hash,
      };
    } catch (err) {
      releaseReservation(envelope.hash, now());
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[safr] Reap checkout failed for envelope ${envelope.hash}: ${detail}`);
      return {
        decision: disposition.decision,
        message: `${disposition.reason} But Reap could not create the checkout (${detail}), so nothing was charged.`,
        envelopeHash: envelope.hash,
      };
    }
  }

  function getApproval(envelopeHash: string): ApprovalRow | undefined {
    return db().prepare(`SELECT * FROM approvals WHERE envelope_hash = ?`).get(envelopeHash) as ApprovalRow | undefined;
  }

  // Single use: only one caller can move PENDING → anything else.
  function claim(envelopeHash: string, status: "APPROVED" | "DECLINED" | "EXPIRED", t: number, reviewer?: string): boolean {
    return (
      db()
        .prepare(`UPDATE approvals SET status = ?, reviewer = ?, decided_at = ? WHERE envelope_hash = ? AND status = 'PENDING'`)
        .run(status, reviewer ?? null, t, envelopeHash).changes === 1
    );
  }

  function pendingOrThrow(envelopeHash: string): ApprovalRow {
    const row = getApproval(envelopeHash);
    if (!row) throw new GateError("NOT_FOUND", 404, "There is no approval request for that envelope.");
    if (row.status !== "PENDING") throw new GateError("ALREADY_DECIDED", 409, `This request was already ${row.status.toLowerCase()}.`);
    return row;
  }

  function expireStaleApprovals(t = now()): number {
    const stale = db()
      .prepare(`SELECT * FROM approvals WHERE status = 'PENDING' AND expires_at <= ?`)
      .all(t) as ApprovalRow[];
    let expired = 0;
    for (const row of stale) {
      if (!claim(row.envelope_hash, "EXPIRED", t)) continue;
      releaseReservation(row.envelope_hash, t);
      audit.append({
        envelope: audit.get(row.audit_seq)!.envelope,
        disposition: {
          decision: "DENY",
          rulesFired: ["APPROVAL_TIMEOUT"],
          reason: "No one approved this within 5 minutes, so it was cancelled and the budget hold released.",
        },
        now: t,
      });
      expired++;
    }
    return expired;
  }

  async function proposeCheckout(raw: ProposeCheckoutInput): Promise<ProposeCheckoutResult> {
    const parsed = ProposeInputSchema.safeParse(raw);
    if (!parsed.success) return { decision: "DENY", message: "The checkout request was malformed, so nothing was proposed.", envelopeHash: "" };
    const input = parsed.data;
    const t = now();
    expireStaleApprovals(t);
    const mandate = loadMandate();

    let quote: Quote;
    try {
      quote = await deps.reap.getQuote(input.quoteId);
    } catch (err) {
      console.warn(`[safr] proposeCheckout: quote ${input.quoteId} unreadable: ${err instanceof Error ? err.message : err}`);
      return { decision: "DENY", message: `Quote ${input.quoteId} could not be read from Reap, so nothing was proposed. Get a fresh quote.`, envelopeHash: "" };
    }

    const trace = toolTraceFor(input.sessionId);
    if (trace.at(-1) !== "proposeCheckout") trace.push("proposeCheckout");
    const { envelope, agent, item } = sealEnvelope(quote, mandate, input.sessionId, trace, input.reason);
    const disposition = decide(envelope, agent, item, mandate, t);
    const entry = audit.append({ envelope, disposition, now: t }); // before any Reap checkout call

    if (disposition.decision === "DENY") return { decision: "DENY", message: disposition.reason, envelopeHash: envelope.hash };

    if (disposition.decision === "ESCALATE") {
      reserve(
        envelope.hash,
        { mandateId: mandate.id, merchantDomain: envelope.action.merchantDomain, amount: envelope.action.amount },
        t,
      );
      db()
        .prepare(
          `INSERT INTO approvals (envelope_hash, audit_seq, session_id, status, created_at, expires_at) VALUES (?, ?, ?, 'PENDING', ?, ?)`,
        )
        .run(envelope.hash, entry.seq, input.sessionId, t, t + APPROVAL_WINDOW_MS);
      return {
        decision: "ESCALATE",
        message: `${disposition.reason} Waiting for approval in the SAFR panel (expires in 5 minutes).`,
        envelopeHash: envelope.hash,
      };
    }

    return execute(envelope, entry.seq, disposition, t);
  }

  async function approve(envelopeHash: string, reviewer: string): Promise<ProposeCheckoutResult> {
    const t = now();
    expireStaleApprovals(t);
    const row = pendingOrThrow(envelopeHash);
    if (!claim(envelopeHash, "APPROVED", t, reviewer)) throw new GateError("ALREADY_DECIDED", 409, "This request was already decided.");

    // What gets bought comes from our own log, never from the approval request.
    const original = audit.get(row.audit_seq)!.envelope;
    const mandate = loadMandate();
    const item = catalog.find((i) => i.sku === original.action.items[0].sku);

    const denyAndRelease = (envelope: Envelope, disposition: Disposition): ProposeCheckoutResult => {
      releaseReservation(envelopeHash, t);
      audit.append({ envelope, disposition, now: t });
      return { decision: "DENY", message: disposition.reason, envelopeHash: envelope.hash };
    };

    let envelope = original;
    let agent = getAgent(agentId);
    try {
      let quote = await deps.reap.getQuote(original.action.quoteId);
      const quoteExpired = t >= Date.parse(quote.expiresAt);
      if (quoteExpired) {
        if (!item) throw new Error("item is not in the catalog");
        quote = await deps.reap.createQuote({ item, quantity: original.action.items[0].quantity, email: email(), shippingAddress });
      }
      if (quoteExpired || mandate.version !== original.context.mandateVersion) {
        ({ envelope, agent } = sealEnvelope(quote, mandate, original.sessionId, original.context.toolTrace, original.context.agentReason));
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return denyAndRelease(original, {
        decision: "DENY",
        rulesFired: ["QUOTE_UNAVAILABLE"],
        reason: `Approved by ${reviewer}, but the quote could not be refreshed (${detail}), so nothing was bought.`,
      });
    }

    // A refreshed quote may not change what is bought or cost more than what the human approved.
    const changed =
      envelope.action.merchantDomain !== original.action.merchantDomain ||
      canonicalize(envelope.action.items) !== canonicalize(original.action.items) ||
      envelope.action.amount.currency !== original.action.amount.currency ||
      envelope.action.amount.amount > original.action.amount.amount;
    if (changed)
      return denyAndRelease(envelope, {
        decision: "DENY",
        rulesFired: ["QUOTE_CHANGED"],
        reason: `The refreshed quote is ${formatMoney(envelope.action.amount)}, more than the ${formatMoney(original.action.amount)} that was approved, so nothing was bought. Propose it again.`,
      });

    // Human approval overrides only the auto-approve threshold; every other rule still applies.
    const recheck = decide(envelope, agent, item, mandate, t, envelopeHash);
    if (recheck.decision === "DENY")
      return denyAndRelease(envelope, { ...recheck, reason: `Approved by ${reviewer}, but blocked on re-check: ${recheck.reason}` });

    if (envelope.hash !== envelopeHash) releaseReservation(envelopeHash, t); // the hold moves to the rebuilt envelope
    const disposition: Disposition = {
      decision: "AUTO_EXECUTE",
      rulesFired: [...recheck.rulesFired, "HUMAN_APPROVED"],
      reason: `Approved by ${reviewer}: ${formatMoney(envelope.action.amount)} at ${envelope.action.merchantDomain}.`,
    };
    const entry = audit.append({ envelope, disposition, now: t }); // before the Reap call
    return execute(envelope, entry.seq, disposition, t);
  }

  async function decline(envelopeHash: string, reviewer: string): Promise<ProposeCheckoutResult> {
    const t = now();
    expireStaleApprovals(t);
    const row = pendingOrThrow(envelopeHash);
    if (!claim(envelopeHash, "DECLINED", t, reviewer)) throw new GateError("ALREADY_DECIDED", 409, "This request was already decided.");
    releaseReservation(envelopeHash, t);
    const disposition: Disposition = {
      decision: "DENY",
      rulesFired: ["HUMAN_DECLINED"],
      reason: `Declined by ${reviewer}, so nothing was bought and the budget hold was released.`,
    };
    const envelope = audit.get(row.audit_seq)!.envelope;
    audit.append({ envelope, disposition, now: t });
    return { decision: "DENY", message: disposition.reason, envelopeHash };
  }

  function listPendingApprovals(): PendingApproval[] {
    expireStaleApprovals(now());
    const rows = db().prepare(`SELECT * FROM approvals WHERE status = 'PENDING' ORDER BY created_at ASC`).all() as ApprovalRow[];
    return rows.map((row) => {
      const entry = audit.get(row.audit_seq)!;
      const { action, context } = entry.envelope;
      return {
        envelopeHash: row.envelope_hash,
        seq: row.audit_seq,
        sessionId: row.session_id,
        merchantDomain: action.merchantDomain,
        sku: action.items[0].sku,
        category: action.category,
        amount: action.amount,
        reason: entry.disposition.reason,
        agentReason: context.agentReason,
        createdAt: new Date(row.created_at).toISOString(),
        expiresAt: new Date(row.expires_at).toISOString(),
      };
    });
  }

  return {
    proposeCheckout,
    approve,
    decline,
    expireStaleApprovals: () => expireStaleApprovals(now()),
    listPendingApprovals,
  };
}

export const gate: SafrGate = createGate({ reap: reapAdapter });

// ---- For A: after polling GET /agentic/checkouts/:id ----

// COMPLETED → the reservation is settled (spent). FAILED / EXPIRED → released.
export function recordCheckoutOutcome(checkoutId: string, status: CheckoutStatus) {
  const entry = audit.findByCheckoutId(checkoutId);
  if (!entry) return null;
  const hash = entry.envelope.hash;
  if (status === "COMPLETED") settle(hash);
  else if (status === "FAILED" || status === "EXPIRED") releaseReservation(hash);
  return { envelopeHash: hash, reservation: getReservation(hash) };
}

// returnUrl is /orders/done?envelopeHash=…; this maps it back to the Reap checkout id.
export function checkoutIdForEnvelope(envelopeHash: string): string | null {
  return audit.latestForEnvelope(envelopeHash)?.checkoutId ?? null;
}

// Guard for any route that creates a checkout: only an envelope the gate cleared, for this quote,
// with its budget hold still open.
export function assertExecutable(envelopeHash: string, quoteId: string): boolean {
  const entry = audit.latestForEnvelope(envelopeHash);
  return (
    !!entry &&
    (entry.disposition.decision === "AUTO_EXECUTE" || entry.disposition.decision === "OBSERVE") &&
    entry.envelope.action.quoteId === quoteId &&
    getReservation(envelopeHash)?.status === "RESERVED"
  );
}
