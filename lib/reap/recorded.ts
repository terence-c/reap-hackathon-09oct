// Offline Reap (REAP_MODE=mock): the same ReapAdapter interface, priced from real sandbox quote
// responses recorded before the sandbox key was revoked, with no network calls at all.
//
// - Quotes: the recorded amounts (integer cents) per catalog sku; quantity scales the item part
//   (subtotal, tax, final minus shipping) and shipping stays. Valid for 10 minutes, like Reap's.
//   The merchant is recorded in the shared quote store, so getQuote behaves like the live adapter.
// - Checkouts: created COMPLETED straight away with a MOCK- order id and no hosted approval step
//   (an autonomous payment, which is what the sandbox's simulate header promises). Idempotent per
//   Idempotency-Key, like Reap.
// - State lives on globalThis: Next bundles each route separately, so /api/agent, /api/approvals
//   and /api/checkout each get their own copy of this module but must see the same quotes.

import { randomUUID } from "node:crypto";
import type { CatalogItem, Checkout, Money, Quote, ReapAdapter } from "../types";
import { ReapError } from "./client";
import { lookupQuote, recordQuote } from "./quote-store";

export const QUOTE_TTL_MS = 10 * 60 * 1000;

type Recorded = { subtotal: number; shipping: number; tax: number; final: number; currency: Money["currency"] };

// Real sandbox responses, converted to cents. Tax is informational: some merchants include it in
// the item price (final = subtotal + shipping), others add it (boxgreen). The laptop stand is
// listed in USD but Reap quotes it converted to SGD; the gate still denies it on the catalog's USD.
// brewlander.com 503s on the live sandbox; it is quoted here so the category denial can be shown.
export const RECORDED_QUOTES: Record<string, Recorded> = {
  "popular-ghost-stories-12": { subtotal: 1079, shipping: 490, tax: 0, final: 1569, currency: "SGD" },
  "kinokuniya-conan-106": { subtotal: 940, shipping: 480, tax: 118, final: 1420, currency: "SGD" },
  "ergotune-pegboard": { subtotal: 5900, shipping: 0, tax: 487, final: 5900, currency: "SGD" },
  "boxgreen-snack-bag": { subtotal: 4500, shipping: 0, tax: 405, final: 4905, currency: "SGD" },
  "byndartisan-luggage-tag": { subtotal: 8500, shipping: 0, tax: 702, final: 8500, currency: "SGD" },
  "picketandrail-geometry-table": { subtotal: 69900, shipping: 0, tax: 5772, final: 69900, currency: "SGD" },
  "zmdesktop-laptop-stand": { subtotal: 7600, shipping: 0, tax: 0, final: 7600, currency: "SGD" },
  "brewlander-6pack": { subtotal: 3300, shipping: 0, tax: 0, final: 3300, currency: "SGD" },
};

type Store = {
  quotes: Map<string, Quote>;
  checkouts: Map<string, Checkout>;
  checkoutByIdempotencyKey: Map<string, string>;
};

const g = globalThis as unknown as { __agentcartRecordedReap?: Store };

function store(): Store {
  return (g.__agentcartRecordedReap ??= { quotes: new Map(), checkouts: new Map(), checkoutByIdempotencyKey: new Map() });
}

// Test helper: forget every recorded quote and checkout.
export function resetRecordedReap() {
  g.__agentcartRecordedReap = undefined;
}

// What the recorded sandbox charges for `quantity` of this item. Unrecorded items fall back to the
// catalog price with no shipping or tax.
export function recordedPrice(item: CatalogItem, quantity: number) {
  const r: Recorded = RECORDED_QUOTES[item.sku] ?? {
    subtotal: item.unitPrice.amount,
    shipping: 0,
    tax: 0,
    final: item.unitPrice.amount,
    currency: item.unitPrice.currency,
  };
  const money = (amount: number): Money => ({ amount, currency: r.currency });
  return {
    itemsSubtotal: money(r.subtotal * quantity),
    shipping: money(r.shipping),
    tax: money(r.tax * quantity),
    finalAmount: money((r.final - r.shipping) * quantity + r.shipping),
  };
}

export const recordedReapAdapter: ReapAdapter = {
  async createQuote({ item, quantity }) {
    if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error("Quote quantity must be a positive integer");
    const quote: Quote = {
      id: `mock_quote_${randomUUID()}`,
      merchantDomain: item.merchantDomain,
      ...recordedPrice(item, quantity),
      expiresAt: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
    };
    store().quotes.set(quote.id, quote);
    recordQuote(quote.id, { merchantDomain: item.merchantDomain, sku: item.sku, quantity });
    return structuredClone(quote);
  },

  async getQuote(id) {
    if (!lookupQuote(id)) throw new Error(`Quote ${id} was not created by this app`);
    const quote = store().quotes.get(id);
    if (!quote) throw new ReapError(404, "QUOTE_NOT_FOUND", `Quote ${id} not found`);
    return structuredClone(quote);
  },

  async createCheckout({ quoteId, idempotencyKey }) {
    const s = store();
    const existing = s.checkoutByIdempotencyKey.get(idempotencyKey);
    if (existing) return structuredClone(s.checkouts.get(existing)!);
    const quote = s.quotes.get(quoteId);
    if (!quote) throw new ReapError(404, "QUOTE_NOT_FOUND", `Quote ${quoteId} not found`);
    if (Date.now() >= Date.parse(quote.expiresAt)) throw new ReapError(422, "QUOTE_EXPIRED", `Quote ${quoteId} has expired`);
    const id = `mock_checkout_${randomUUID()}`;
    const checkout: Checkout = {
      id,
      status: "COMPLETED",
      orderId: `MOCK-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`,
      finalAmount: { ...quote.finalAmount },
    };
    s.checkouts.set(id, checkout);
    s.checkoutByIdempotencyKey.set(idempotencyKey, id);
    return structuredClone(checkout);
  },

  async getCheckout(id) {
    const checkout = store().checkouts.get(id);
    if (!checkout) throw new ReapError(404, "CHECKOUT_NOT_FOUND", `Checkout ${id} not found`);
    return structuredClone(checkout);
  },

  async pollCheckout(id) {
    return recordedReapAdapter.getCheckout(id);
  },
};
