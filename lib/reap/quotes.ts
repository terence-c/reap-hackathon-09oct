import type { CatalogItem, Currency, Quote, ShippingAddress } from "@/lib/types";
import { ReapError, reapFetch } from "./client";

type ReapMoney = { amount: number; currency: Currency };
type QuoteResponse = {
  id: string;
  amountBreakdown: {
    itemsSubtotal: ReapMoney;
    shipping: ReapMoney;
    tax: { amount: ReapMoney } | ReapMoney;
    finalAmount: ReapMoney;
  };
  expiresAt: string;
};

const demoAddress: ShippingAddress = {
  firstName: "Demo",
  lastName: "User",
  phone: "+6590000000",
  addressLine1: "1 Raffles Place",
  city: "Singapore",
  postalCode: "048616",
  country: "SG",
};

function mapQuote(response: QuoteResponse, merchantDomain: string): Quote {
  const tax = "amount" in response.amountBreakdown.tax &&
    typeof response.amountBreakdown.tax.amount === "object"
    ? response.amountBreakdown.tax.amount
    : response.amountBreakdown.tax as ReapMoney;
  return {
    id: response.id,
    merchantDomain,
    finalAmount: response.amountBreakdown.finalAmount,
    itemsSubtotal: response.amountBreakdown.itemsSubtotal,
    shipping: response.amountBreakdown.shipping,
    tax,
    expiresAt: response.expiresAt,
  };
}

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
  const address = input.shippingAddress ?? demoAddress;
  const body = {
    externalCheckout: {
      merchantDomain: input.item.merchantDomain,
      checkoutUrl: quantityUrl(input.item, input.quantity),
    },
    email: input.email,
    shippingAddress: address,
  };
  const idempotencyKey = `quote-${crypto.randomUUID()}`;
  try {
    const response = await reapFetch<QuoteResponse>("/agentic/quotes", {
      method: "POST", body, idempotencyKey,
    });
    return mapQuote(response, input.item.merchantDomain);
  } catch (error) {
    // Reap discovery variant IDs are a supported alternative when a merchant permalink is rejected.
    if (!(error instanceof ReapError) || error.code !== "CHECKOUT_URL_INVALID") throw error;
    const response = await reapFetch<QuoteResponse>("/agentic/quotes", {
      method: "POST",
      body: {
        items: [{ variantId: input.item.variantId, quantity: input.quantity }],
        email: input.email,
        shippingAddress: address,
      },
      idempotencyKey: `quote-${crypto.randomUUID()}`,
    });
    return mapQuote(response, input.item.merchantDomain);
  }
}

export async function getQuote(id: string): Promise<Quote> {
  const response = await reapFetch<QuoteResponse>(`/agentic/quotes/${encodeURIComponent(id)}`);
  // The server-side caller should compare this against its catalog item before authorization.
  return mapQuote(response, "");
}

export { demoAddress };
