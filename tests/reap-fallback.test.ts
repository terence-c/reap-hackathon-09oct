// The auto-mode adapter (lib/reap/index.ts createFallbackReapAdapter): live first, recorded
// when the sandbox can't be reached, with cooldown and id-prefix routing. Fake adapters only —
// no network, no env needed beyond what the module already reads.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReapError } from "@/lib/reap/client";
import { lastFallback, resetReapFallback } from "@/lib/reap/fallback";
import { createFallbackReapAdapter } from "@/lib/reap";
import { recordedReapAdapter, resetRecordedReap } from "@/lib/reap/recorded";
import type { CatalogItem, Checkout, Quote, ReapAdapter } from "@/lib/types";

const item: CatalogItem = {
  sku: "popular-ghost-stories-12",
  merchantDomain: "popular.sg",
  name: "True Singapore Ghost Stories Book 12",
  category: "Books",
  unitPrice: { amount: 1079, currency: "SGD" },
  checkoutUrl: "https://popular.sg/cart/123:1",
  variantId: "123",
};

const liveQuote: Quote = {
  id: "q_live_1",
  merchantDomain: item.merchantDomain,
  itemsSubtotal: { amount: 1079, currency: "SGD" },
  shipping: { amount: 490, currency: "SGD" },
  tax: { amount: 0, currency: "SGD" },
  finalAmount: { amount: 1569, currency: "SGD" },
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
};

function fakeLive(overrides: Partial<ReapAdapter> = {}): ReapAdapter {
  return {
    createQuote: vi.fn(async () => liveQuote),
    getQuote: vi.fn(async () => liveQuote),
    createCheckout: vi.fn(async () => ({ id: "chk_live", status: "REQUIRES_ACTION" }) as Checkout),
    getCheckout: vi.fn(async () => ({ id: "chk_live", status: "COMPLETED" }) as Checkout),
    pollCheckout: vi.fn(async () => ({ id: "chk_live", status: "COMPLETED" }) as Checkout),
    ...overrides,
  };
}

const recordedAdapter = (): ReapAdapter => recordedReapAdapter;

const input = { item, quantity: 1, email: "demo@example.com", shippingAddress: { firstName: "A", lastName: "B", phone: "+6591234567", addressLine1: "1 Raffles Place", city: "Singapore", postalCode: "048616", country: "SG" as const } };

describe("createFallbackReapAdapter", () => {
  beforeEach(() => {
    resetReapFallback();
    resetRecordedReap();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("serves the live quote when the sandbox answers", async () => {
    const live = fakeLive();
    const adapter = createFallbackReapAdapter(live, recordedAdapter(), { now: () => 0 });
    const quote = await adapter.createQuote(input);
    expect(quote.id).toBe("q_live_1");
    expect(lastFallback()).toBeNull();
  });

  it.each([
    ["401 INVALID_API_KEY", new ReapError(401, "INVALID_API_KEY", "Invalid API key")],
    ["403", new ReapError(403, "FORBIDDEN", "forbidden")],
    ["429", new ReapError(429, "RATE_LIMITED", "slow down")],
    ["503", new ReapError(503, "AGENTIC_SERVICE_UNAVAILABLE", "unavailable")],
    ["fetch TypeError", new TypeError("fetch failed")],
    ["missing env", new Error("Missing or invalid env vars: REAP_API_KEY. Set them in .env.local.")],
  ])("falls back to the recorded price on %s and remembers it", async (_name, error) => {
    const live = fakeLive({ createQuote: vi.fn(async () => { throw error; }) });
    const adapter = createFallbackReapAdapter(live, recordedAdapter(), { now: () => 1_000 });
    const quote = await adapter.createQuote(input);
    expect(quote.id).toMatch(/^mock_quote_/);
    expect(quote.merchantDomain).toBe(item.merchantDomain);
    expect(lastFallback()).toMatchObject({ reason: expect.any(String) });
  });

  it("rethrows a real answer from Reap (422) without falling back", async () => {
    const bad = new ReapError(422, "CHECKOUT_URL_INVALID", "bad url");
    const live = fakeLive({ createQuote: vi.fn(async () => { throw bad; }) });
    const adapter = createFallbackReapAdapter(live, recordedAdapter(), { now: () => 0 });
    await expect(adapter.createQuote(input)).rejects.toBe(bad);
    expect(lastFallback()).toBeNull();
  });

  it("cools down after a fallback, then tries live again", async () => {
    let t = 0;
    const live = fakeLive({ createQuote: vi.fn(async () => { throw new ReapError(503, "X", "down"); }) });
    const recorded = recordedAdapter();
    const createSpy = vi.spyOn(recorded, "createQuote");
    const adapter = createFallbackReapAdapter(live, recorded, { now: () => t });

    await adapter.createQuote(input); // live fails → fallback
    await adapter.createQuote(input); // within 60 s: live not called again
    expect(live.createQuote).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledTimes(2);

    t = 61_000; // past the cooldown
    await adapter.createQuote(input);
    expect(live.createQuote).toHaveBeenCalledTimes(2);
  });

  it("routes reads and checkouts by id prefix — mock ids to recorded, others to live", async () => {
    const live = fakeLive();
    const recorded = recordedAdapter();
    const adapter = createFallbackReapAdapter(live, recorded, { now: () => 0 });

    const quote = await recorded.createQuote(input); // mock_quote_…
    await adapter.getQuote(quote.id);
    expect(live.getQuote).not.toHaveBeenCalled();
    await adapter.getQuote("q_live_1");
    expect(live.getQuote).toHaveBeenCalledWith("q_live_1");

    const checkout = await adapter.createCheckout({ quoteId: quote.id, enrollmentId: "e", returnUrl: "https://x", idempotencyKey: "k" });
    expect(checkout.id).toMatch(/^mock_checkout_/);
    expect(live.createCheckout).not.toHaveBeenCalled();
    await adapter.createCheckout({ quoteId: "q_live_1", enrollmentId: "e", returnUrl: "https://x", idempotencyKey: "k2" });
    expect(live.createCheckout).toHaveBeenCalledOnce();

    await adapter.getCheckout(checkout.id);
    expect(live.getCheckout).not.toHaveBeenCalled();
    await adapter.getCheckout("chk_live");
    expect(live.getCheckout).toHaveBeenCalledWith("chk_live");

    await adapter.pollCheckout(checkout.id);
    await adapter.pollCheckout("chk_live");
    expect(live.pollCheckout).toHaveBeenCalledWith("chk_live", undefined);
  });
});

