import { createHash, randomUUID } from "crypto";
import { env } from "@/lib/env";
import defaultMandate from "@/lib/mandate.demo.json";
import type {
  AuditEntry,
  CatalogItem,
  Envelope,
  Gate,
  Mandate,
  ProposeCheckoutResult,
  Quote,
  ReapAdapter,
} from "@/lib/types";
import { SYSTEM_PROMPT } from "./system-prompt";

export const TOOL_NAMES = ["listCatalog", "getQuote", "proposeCheckout"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export type ToolEvent = {
  seq: number;
  ts: string;
  type: "TOOL_CALL" | "TOOL_DENIED";
  agentId: string;
  toolName: string;
};

export type QuoteRecord = { quote: Quote; item: CatalogItem; quantity: number };

export type Session = {
  id: string;
  createdAt: number;
  lastSeen: number;
  mandate: Mandate;
  quotes: Map<string, QuoteRecord>;
  proposals: Map<string, ProposeCheckoutResult>;
  audit: AuditEntry[];
  toolEvents: ToolEvent[];
  eventSeq: number;
};

type Store = { sessions: Map<string, Session> };

const SESSION_TTL_MS = 60 * 60 * 1000;
const MAX_SESSIONS = 1000;
const QUOTE_TTL_MS = 10 * 60 * 1000;
const SHIPPING_CENTS = 500;

const storeKey = "__agentcartStubStore";

function store(): Store {
  const g = globalThis as unknown as Record<string, Store | undefined>;
  return (g[storeKey] ??= { sessions: new Map() });
}

function sweepExpired(now: number) {
  const s = store();
  for (const [id, session] of s.sessions) {
    if (now - session.lastSeen > SESSION_TTL_MS) s.sessions.delete(id);
  }
}

function evictOldest() {
  const s = store();
  let oldestId: string | undefined;
  let oldest = Infinity;
  for (const [id, session] of s.sessions) {
    if (session.lastSeen < oldest) {
      oldest = session.lastSeen;
      oldestId = id;
    }
  }
  if (oldestId) s.sessions.delete(oldestId);
}

export function getOrCreateSession(id: string): Session {
  const now = Date.now();
  sweepExpired(now);
  const s = store();
  let session = s.sessions.get(id);
  if (!session) {
    if (s.sessions.size >= MAX_SESSIONS) evictOldest();
    session = {
      id,
      createdAt: now,
      lastSeen: now,
      mandate: structuredClone(defaultMandate) as Mandate,
      quotes: new Map(),
      proposals: new Map(),
      audit: [],
      toolEvents: [],
      eventSeq: 0,
    };
    s.sessions.set(id, session);
  }
  session.lastSeen = now;
  return session;
}

export function findSession(id: string): Session | undefined {
  const session = store().sessions.get(id);
  if (!session) return undefined;
  session.lastSeen = Date.now();
  return session;
}

export function promptHash(): string {
  return sha256Hex(SYSTEM_PROMPT);
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function recordToolEvent(
  session: Session,
  type: ToolEvent["type"],
  agentId: string,
  toolName: string,
): ToolEvent {
  const event: ToolEvent = {
    seq: ++session.eventSeq,
    ts: new Date().toISOString(),
    type,
    agentId,
    toolName,
  };
  session.toolEvents.push(event);
  return event;
}

export const stubRegistry = {
  isToolAllowed(agentId: string, toolName: string, sessionId: string): boolean {
    const session = findSession(sessionId);
    if (!session || session.mandate.killSwitch) return false;
    if (agentId !== env.AGENT_ID) return false;
    return (TOOL_NAMES as readonly string[]).includes(toolName);
  },
};

export const stubAudit = {
  append(session: Session, entry: AuditEntry): AuditEntry {
    session.audit.push(entry);
    return entry;
  },
};

type CreateQuoteInput = Parameters<ReapAdapter["createQuote"]>[0];

export async function createStubQuote(
  sessionId: string,
  input: CreateQuoteInput,
): Promise<Quote> {
  const session = getOrCreateSession(sessionId);
  const { item, quantity } = input;
  const currency = item.unitPrice.currency;
  const subtotal = item.unitPrice.amount * quantity;
  const quote: Quote = {
    id: `stub-quote-${randomUUID()}`,
    merchantDomain: item.merchantDomain,
    finalAmount: { amount: subtotal + SHIPPING_CENTS, currency },
    itemsSubtotal: { amount: subtotal, currency },
    shipping: { amount: SHIPPING_CENTS, currency },
    tax: { amount: 0, currency },
    expiresAt: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
  };
  session.quotes.set(quote.id, { quote, item, quantity });
  return quote;
}

export const stubGate: Gate = {
  async proposeCheckout({ quoteId, reason, sessionId }): Promise<ProposeCheckoutResult> {
    const session = getOrCreateSession(sessionId);
    const record = session.quotes.get(quoteId);
    if (!record) {
      throw new Error("This price is not available for this chat. Please ask for a new price.");
    }
    if (Date.parse(record.quote.expiresAt) <= Date.now()) {
      session.quotes.delete(quoteId);
      throw new Error("This price has expired. Please ask for a new price.");
    }
    const cached = session.proposals.get(quoteId);
    if (cached) return cached;

    const envelopeBody: Omit<Envelope, "hash" | "signature"> = {
      envelopeId: `stub-env-${randomUUID()}`,
      schemaVersion: "1.0",
      agent: {
        agentId: env.AGENT_ID,
        model: env.OPENAI_MODEL,
        promptHash: promptHash(),
      },
      principalId: session.mandate.principalId,
      sessionId,
      action: {
        type: "CREATE_CHECKOUT",
        quoteId,
        merchantDomain: record.item.merchantDomain,
        category: record.item.category,
        items: [{ sku: record.item.sku, quantity: record.quantity }],
        amount: record.quote.finalAmount,
      },
      context: {
        mandateId: session.mandate.id,
        mandateVersion: session.mandate.version,
        quoteExpiresAt: record.quote.expiresAt,
        toolTrace: session.toolEvents
          .filter((e) => e.type === "TOOL_CALL")
          .map((e) => `${e.seq}:${e.toolName}`),
        agentReason: reason,
      },
    };
    const envelope: Envelope = {
      ...envelopeBody,
      hash: sha256Hex(canonical(envelopeBody)),
      signature: "",
    };
    const disposition = {
      decision: "AUTO_EXECUTE" as const,
      rulesFired: ["stub:auto-execute"],
      reason:
        "This request is allowed in the demo. No order was placed and no payment was made.",
    };
    const entry: AuditEntry = {
      seq: session.audit.length + 1,
      ts: new Date().toISOString(),
      envelope,
      disposition,
      executed: false,
      prevHash: session.audit.at(-1)?.hash ?? "",
      hash: "",
    };
    entry.hash = auditHash(entry);
    stubAudit.append(session, entry);

    const result: ProposeCheckoutResult = {
      decision: disposition.decision,
      message: disposition.reason,
      approvalUrl: `/?stubApproval=${envelope.envelopeId}`,
      envelopeHash: envelope.hash,
    };
    session.proposals.set(quoteId, result);
    return result;
  },
};

function envelopeBody(envelope: Envelope): Omit<Envelope, "hash" | "signature"> {
  return {
    envelopeId: envelope.envelopeId,
    schemaVersion: envelope.schemaVersion,
    agent: envelope.agent,
    principalId: envelope.principalId,
    sessionId: envelope.sessionId,
    action: envelope.action,
    context: envelope.context,
  };
}

function envelopeHash(envelope: Envelope): string {
  return sha256Hex(canonical(envelopeBody(envelope)));
}

function auditHash(entry: AuditEntry): string {
  return sha256Hex(
    canonical({
      seq: entry.seq,
      ts: entry.ts,
      envelopeHash: entry.envelope.hash,
      disposition: entry.disposition,
      executed: entry.executed,
      checkoutId: entry.checkoutId,
      prevHash: entry.prevHash,
    }),
  );
}

export function verifyAuditChain(session: Session): boolean {
  let prevHash = "";
  for (let i = 0; i < session.audit.length; i++) {
    const entry = session.audit[i];
    if (entry.seq !== i + 1) return false;
    if (entry.prevHash !== prevHash) return false;
    if (envelopeHash(entry.envelope) !== entry.envelope.hash) return false;
    if (auditHash(entry) !== entry.hash) return false;
    prevHash = entry.hash;
  }
  return true;
}

export function updateMandate(
  session: Session,
  patch: Pick<
    Mandate,
    "currency" | "totalBudget" | "autoThreshold" | "allowedCategories" | "validFrom" | "validTo"
  >,
): Mandate {
  session.mandate = { ...session.mandate, ...patch, version: session.mandate.version + 1 };
  return session.mandate;
}
