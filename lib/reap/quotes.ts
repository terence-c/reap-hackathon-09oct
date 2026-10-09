import { z } from "zod";
import type { CatalogItem, Quote, ShippingAddress } from "@/lib/types";
import { ReapError, reapFetch } from "./client";
import { ReapMoneySchema } from "./money";
import { lookupQuote, recordQuote } from "./quote-store";

// Verified against the sandbox: Reap validates phone as ^\+[1-9]\d{6,14}$ and merchants reject
// obviously fake numbers, so this is a real-format SG mobile and a real SG postcode.
export const DEMO_SHIPPING_ADDRESS: ShippingAddress = {
  firstName: "Agent",
  lastName: "Cart",
  phone: "+6591234567",
  addressLine1: "1 Raffles Place",
  city: "Singapore",
  postalCode: "048616",
  country: "SG",
};

// Totals are nested under amountBreakdown. Tax is informational (often already included in
// prices); finalAmount is what gets charged.
const QuoteResponseSchema = z.object({
  id: z.string().min(1),
  amountBreakdown: z.object({
    itemsSubtotal: ReapMoneySchema,
    shipping: ReapMoneySchema,
    tax: z.union([z.object({ amount: ReapMoneySchema }).transform((t) => t.amount), ReapMoneySchema]),
    finalAmount: ReapMoneySchema,
  }),
  expiresAt: z.string(),
});

function toQuote(raw: unknown, merchantDomain: string): Quote {
  const parsed = QuoteResponseSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Unexpected quote response from Reap: ${parsed.error.issues[0]?.message}`);
  const { id, amountBreakdown: b, expiresAt } = parsed.data;
  return {
    id,
    merchantDomain,
    finalAmount: b.finalAmount,
    itemsSubtotal: b.itemsSubtotal,
    shipping: b.shipping,
    tax: b.tax,
    expiresAt,
  };
}

// The merchant-sheet permalinks are /cart/<variantId>:<qty>; rewrite the quantity in place.
function quantityUrl(item: CatalogItem, quantity: number): string {
  const url = new URL(item.checkoutUrl);
  const segment = `/cart/${item.variantId}:`;
  if (!url.pathname.includes(segment)) {
    throw new Error(`Catalog checkout URL does not contain variant ${item.variantId}`);
  }
  url.pathname = url.pathname.replace(new RegExp(`(/cart/${item.variantId}:)\\d+`), `$1${quantity}`);
  return url.toString();
}

export async function createQuote(input: {
  item: CatalogItem;
  quantity: number;
  email: string;
  shippingAddress: ShippingAddress;
}): Promise<Quote> {
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) {
    throw new Error("Quote quantity must be a positive integer");
  }
  const { item, quantity, email } = input;
  const shippingAddress = input.shippingAddress ?? DEMO_SHIPPING_ADDRESS;
  let raw: unknown;
  try {
    raw = await reapFetch("/agentic/quotes", {
      method: "POST",
      idempotencyKey: `quote-${crypto.randomUUID()}`,
      body: {
        externalCheckout: { merchantDomain: item.merchantDomain, checkoutUrl: quantityUrl(item, quantity) },
        email,
        shippingAddress,
      },
    });
  } catch (error) {
    // Reap discovery variant IDs are the supported alternative when a merchant permalink is rejected.
    if (!(error instanceof ReapError) || error.code !== "CHECKOUT_URL_INVALID") throw error;
    raw = await reapFetch("/agentic/quotes", {
      method: "POST",
      idempotencyKey: `quote-${crypto.randomUUID()}`,
      body: { items: [{ variantId: item.variantId, quantity }], email, shippingAddress },
    });
  }
  const quote = toQuote(raw, item.merchantDomain);
  recordQuote(quote.id, { merchantDomain: item.merchantDomain, sku: item.sku, quantity });
  return quote;
}

// Re-reads the live quote from Reap; the merchant comes from our own record of the quote.
export async function getQuote(id: string): Promise<Quote> {
  const line = lookupQuote(id);
  if (!line) throw new Error(`Quote ${id} was not created by this app`);
  const raw = await reapFetch(`/agentic/quotes/${encodeURIComponent(id)}`);
  return toQuote(raw, line.merchantDomain);
}
