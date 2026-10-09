// In-memory stand-in for A's Reap adapter, same ReapAdapter interface. Used by the tests and by
// the gate until A's lib/reap adapter lands (see reap-adapter.ts). Never talks to the network.

import type { CatalogItem, Checkout, Quote, ReapAdapter } from "../types";

export type MockReap = ReapAdapter & {
  checkoutsCreated(): number;
  expireQuote(id: string): void;
};

export function createMockReap(opts: { shipping?: number; quoteTtlMs?: number; now?: () => number } = {}): MockReap {
  const shipping = opts.shipping ?? 500;
  const quoteTtlMs = opts.quoteTtlMs ?? 10 * 60 * 1000;
  const now = opts.now ?? Date.now;
  const quotes = new Map<string, Quote>();
  const checkouts = new Map<string, Checkout>();
  const byIdempotencyKey = new Map<string, string>();
  let counter = 0;

  function quoteFor(item: CatalogItem, quantity: number): Quote {
    const currency = item.unitPrice.currency;
    const subtotal = item.unitPrice.amount * quantity;
    return {
      id: `mock_quote_${++counter}`,
      merchantDomain: item.merchantDomain,
      itemsSubtotal: { amount: subtotal, currency },
      shipping: { amount: shipping, currency },
      tax: { amount: 0, currency },
      finalAmount: { amount: subtotal + shipping, currency },
      expiresAt: new Date(now() + quoteTtlMs).toISOString(),
    };
  }

  return {
    async createQuote({ item, quantity }) {
      const quote = quoteFor(item, quantity);
      quotes.set(quote.id, quote);
      return quote;
    },
    async getQuote(id) {
      const quote = quotes.get(id);
      if (!quote) throw new Error(`Quote ${id} not found`);
      return quote;
    },
    async createCheckout({ quoteId, idempotencyKey }) {
      const existing = byIdempotencyKey.get(idempotencyKey);
      if (existing) return checkouts.get(existing)!;
      const quote = quotes.get(quoteId);
      if (!quote) throw new Error(`Quote ${quoteId} not found`);
      const id = `mock_checkout_${++counter}`;
      const checkout: Checkout = {
        id,
        status: "REQUIRES_ACTION",
        finalAmount: quote.finalAmount,
        nextAction: { url: `https://mock-reap.invalid/checkouts/${id}/approve`, expiresAt: quote.expiresAt },
      };
      checkouts.set(id, checkout);
      byIdempotencyKey.set(idempotencyKey, id);
      return checkout;
    },
    async getCheckout(id) {
      const checkout = checkouts.get(id);
      if (!checkout) throw new Error(`Checkout ${id} not found`);
      return { ...checkout, status: "COMPLETED", orderId: `mock_order_${id}`, nextAction: undefined };
    },
    async pollCheckout(id) {
      return this.getCheckout(id);
    },
    checkoutsCreated: () => checkouts.size,
    expireQuote(id) {
      const quote = quotes.get(id);
      if (quote) quotes.set(id, { ...quote, expiresAt: new Date(now() - 1).toISOString() });
    },
  };
}
