// Governance Envelope: the signed, hashed record of one proposed action. Every field is filled
// from server-side state (quote, catalog, mandate, registry). The agent supplies only quoteId
// and a free-text reason, which is stored as data and never parsed.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { z } from "zod";
import type { CatalogItem, Envelope, Mandate, Quote } from "../types";

const MoneySchema = z.object({
  amount: z.number().int(),
  currency: z.enum(["SGD", "USD"]),
});

export const EnvelopeSchema: z.ZodType<Envelope> = z.object({
  envelopeId: z.string().min(1),
  schemaVersion: z.literal("1.0"),
  agent: z.object({ agentId: z.string().min(1), model: z.string(), promptHash: z.string() }),
  principalId: z.string().min(1),
  sessionId: z.string().min(1),
  action: z.object({
    type: z.literal("CREATE_CHECKOUT"),
    quoteId: z.string().min(1),
    merchantDomain: z.string().min(1),
    category: z.string().min(1),
    items: z.array(z.object({ sku: z.string().min(1), quantity: z.number().int().positive() })).min(1),
    amount: MoneySchema,
  }),
  context: z.object({
    mandateId: z.string().min(1),
    mandateVersion: z.number().int(),
    quoteExpiresAt: z.string(),
    toolTrace: z.array(z.string()),
    agentReason: z.string(),
  }),
  hash: z.string(),
  signature: z.string(),
});

export type UnsignedEnvelope = Omit<Envelope, "hash" | "signature">;

// Stable JSON: object keys sorted at every level, undefined fields dropped, arrays kept in order.
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function hashEnvelope(envelope: UnsignedEnvelope | Envelope): string {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { hash, signature, ...unsigned } = envelope as Envelope;
  return sha256(canonicalize(unsigned));
}

// ---- Ed25519 keys: private = base64 PKCS#8 DER (AGENT_PRIVATE_KEY), public = base64 SPKI DER ----

export function generateAgentKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}

export function publicKeyFromPrivate(privateKey: string): string {
  const key = createPrivateKey({ key: Buffer.from(privateKey, "base64"), format: "der", type: "pkcs8" });
  return createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64");
}

// Hash the canonical form, sign the hash. With no private key the envelope is left unsigned
// (signature ""), which the gate denies at the identity step — it is still audited.
export function signEnvelope(unsigned: UnsignedEnvelope, privateKey: string | undefined): Envelope {
  const hash = hashEnvelope(unsigned);
  if (!privateKey) return { ...unsigned, hash, signature: "" };
  const key = createPrivateKey({ key: Buffer.from(privateKey, "base64"), format: "der", type: "pkcs8" });
  const signature = sign(null, Buffer.from(hash), key).toString("base64");
  return { ...unsigned, hash, signature };
}

export type SignatureCheck = { ok: true } | { ok: false; reason: string };

export function verifyEnvelope(envelope: Envelope, publicKey: string | null | undefined): SignatureCheck {
  if (!EnvelopeSchema.safeParse(envelope).success) return { ok: false, reason: "envelope is malformed" };
  if (hashEnvelope(envelope) !== envelope.hash) return { ok: false, reason: "envelope contents do not match its hash" };
  if (!envelope.signature) return { ok: false, reason: "envelope is unsigned (AGENT_PRIVATE_KEY not set — run npm run keygen)" };
  if (!publicKey) return { ok: false, reason: "agent has no registered public key (run npm run keygen)" };
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
    const valid = verify(null, Buffer.from(envelope.hash), key, Buffer.from(envelope.signature, "base64"));
    return valid ? { ok: true } : { ok: false, reason: "signature does not match the registered public key" };
  } catch {
    return { ok: false, reason: "signature or public key could not be parsed" };
  }
}

// ---- Quote → catalog line. Quote has no sku, so match on merchant domain (unique in the catalog). ----

export function findCatalogItem(catalog: CatalogItem[], quote: Quote): CatalogItem | undefined {
  return catalog.find((item) => item.merchantDomain === quote.merchantDomain);
}

// Quantity is derived from the trusted quote, never taken from the agent. Every rule uses
// quote.finalAmount; quantity is recorded for the audit trail only.
export function deriveQuantity(item: CatalogItem, quote: Quote): number {
  const { amount, currency } = quote.itemsSubtotal;
  if (currency !== item.unitPrice.currency || item.unitPrice.amount <= 0) return 1;
  const quantity = amount / item.unitPrice.amount;
  return Number.isInteger(quantity) && quantity >= 1 ? quantity : 1;
}

export function buildEnvelope(input: {
  quote: Quote;
  catalogItem: CatalogItem | undefined; // undefined = merchant not in our catalog; denied on category
  quantity: number;
  mandate: Mandate;
  agent: { agentId: string; model: string; promptHash: string };
  sessionId: string;
  toolTrace: string[];
  agentReason: string;
}): UnsignedEnvelope {
  const { quote, catalogItem, mandate } = input;
  return {
    envelopeId: randomUUID(),
    schemaVersion: "1.0",
    agent: { ...input.agent },
    principalId: mandate.principalId,
    sessionId: input.sessionId,
    action: {
      type: "CREATE_CHECKOUT",
      quoteId: quote.id,
      merchantDomain: quote.merchantDomain,
      category: catalogItem?.category ?? "Uncatalogued",
      items: [{ sku: catalogItem?.sku ?? "uncatalogued", quantity: input.quantity }],
      amount: { ...quote.finalAmount },
    },
    context: {
      mandateId: mandate.id,
      mandateVersion: mandate.version,
      quoteExpiresAt: quote.expiresAt,
      toolTrace: [...input.toolTrace],
      agentReason: input.agentReason.slice(0, 500),
    },
  };
}
