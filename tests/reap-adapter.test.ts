// Lane A's Reap adapter against a stubbed fetch (no network). Fixtures are real sandbox
// responses: Reap sends money as decimal major units, the adapter turns it into integer cents.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import catalogJson from "@/lib/catalog.json";
import { reapAdapter, ReapError, DEMO_SHIPPING_ADDRESS } from "@/lib/reap";
import { toCents } from "@/lib/reap/money";
import { lookupQuote } from "@/lib/reap/quote-store";
import { db, openInMemoryDb } from "@/lib/safr/db";
import type { CatalogItem } from "@/lib/types";

// env validates the REAP_* group on first access and caches it, so set it before anything runs.
vi.hoisted(() => {
  process.env.REAP_API_KEY = "test";
  process.env.REAP_BASE_URL = "https://sg.sandbox.api.reap.global";
  process.env.REAP_API_VERSION = "2025-02-14";
  process.env.REAP_SIMULATE_CHECKOUT = "true";
});

const BASE = "https://sg.sandbox.api.reap.global";
const BOOK = (catalogJson as CatalogItem[]).find((i) => i.sku === "popular-ghost-stories-12")!;

// The verified sandbox quote for the ghost-stories book (tax nested as { amount: Money }).
const BOOK_QUOTE = {
  id: "6c1a5ee1-0ca9-4ae3-863e-d916677b630b",
  shippingOptions: [
    { id: "ship_0", name: "LOCAL DELIVERY - STANDARD (BELOW $90)", selected: true, price: { amount: 4.9, currency: "SGD" } },
  ],
  amountBreakdown: {
    itemsSubtotal: { amount: 10.79, currency: "SGD" },
    shipping: { amount: 4.9, currency: "SGD" },
    tax: { amount: { amount: 0, currency: "SGD" } },
    discounts: [],
    additionalCharges: [],
    finalAmount: { amount: 15.69, currency: "SGD" },
  },
  expiresAt: "2026-10-09T12:07:22.492Z",
};

let fetchMock: Mock;

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sent(i = 0) {
  const [url, init] = fetchMock.mock.calls[i] as [URL | string, RequestInit];
  return {
    url: String(url),
    method: init.method,
    headers: init.headers as Record<string, string>,
    body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
  };
}

function quoteBook(quantity = 1) {
  return reapAdapter.createQuote({ item: BOOK, quantity, email: "demo@example.com", shippingAddress: DEMO_SHIPPING_ADDRESS });
}

beforeEach(() => {
  openInMemoryDb();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("toCents", () => {
  it("converts Reap's decimal amounts to integer cents", () => {
    expect(toCents(10.79)).toBe(1079);
    expect(toCents(15.69)).toBe(1569);
    expect(toCents(4.9)).toBe(490);
    expect(toCents(76)).toBe(7600);
    expect(toCents(0)).toBe(0);
  });

  it("rejects sub-cent amounts and non-numbers", () => {
    expect(() => toCents(1.005)).toThrow(/more than 2 decimals/);
    expect(() => toCents(NaN)).toThrow(/not a number/);
    expect(() => toCents(Infinity)).toThrow(/not a number/);
  });
});

describe("createQuote / getQuote", () => {
  it("maps amountBreakdown to cents and records the merchant for getQuote", async () => {
    fetchMock.mockResolvedValueOnce(reply(BOOK_QUOTE)).mockResolvedValueOnce(reply(BOOK_QUOTE));

    const quote = await quoteBook();
    expect(quote).toEqual({
      id: BOOK_QUOTE.id,
      merchantDomain: "popular.com.sg",
      itemsSubtotal: { amount: 1079, currency: "SGD" },
      shipping: { amount: 490, currency: "SGD" },
      tax: { amount: 0, currency: "SGD" },
      finalAmount: { amount: 1569, currency: "SGD" },
      expiresAt: BOOK_QUOTE.expiresAt,
    });
    expect(lookupQuote(BOOK_QUOTE.id)).toEqual({ merchantDomain: "popular.com.sg", sku: BOOK.sku, quantity: 1 });

    // Reap's GET /agentic/quotes/:id has no merchant either; it comes from our record.
    const reread = await reapAdapter.getQuote(BOOK_QUOTE.id);
    expect(reread).toEqual(quote);
    expect(sent(1)).toMatchObject({ method: "GET", url: `${BASE}/agentic/quotes/${BOOK_QUOTE.id}` });
  });

  it("also accepts tax as plain money", async () => {
    const plainTax = {
      ...BOOK_QUOTE,
      amountBreakdown: { ...BOOK_QUOTE.amountBreakdown, tax: { amount: 1.23, currency: "SGD" } },
    };
    fetchMock.mockResolvedValueOnce(reply(plainTax));
    expect((await quoteBook()).tax).toEqual({ amount: 123, currency: "SGD" });
  });

  it("sends auth, Reap-Version and an Idempotency-Key, with the quantity in the cart URL", async () => {
    fetchMock.mockResolvedValueOnce(reply(BOOK_QUOTE));
    await quoteBook(2);

    const req = sent();
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${BASE}/agentic/quotes`);
    expect(req.headers.Authorization).toBe("Bearer test");
    expect(req.headers["Reap-Version"]).toBe("2025-02-14");
    expect(req.headers["Idempotency-Key"]).toMatch(/^quote-.+/);
    expect(req.headers["X-Simulate-Checkout"]).toBeUndefined();
    expect(req.body).toMatchObject({
      externalCheckout: { merchantDomain: "popular.com.sg", checkoutUrl: expect.stringContaining("/cart/44237547733199:2") },
      email: "demo@example.com",
      shippingAddress: DEMO_SHIPPING_ADDRESS,
    });
  });

  it("getQuote on a quote this app never created throws without calling Reap", async () => {
    await expect(reapAdapter.getQuote("not-ours")).rejects.toThrow(/not created by this app/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("createCheckout / getCheckout", () => {
  const input = {
    quoteId: BOOK_QUOTE.id,
    enrollmentId: "enr_test",
    returnUrl: "https://localhost:3443/orders/done?envelopeHash=abc",
    idempotencyKey: "envelope-hash-123",
  };

  it("rejects an http:// returnUrl before calling Reap", async () => {
    await expect(reapAdapter.createCheckout({ ...input, returnUrl: "http://localhost:3000/orders/done" })).rejects.toThrow(
      /must be HTTPS/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends X-Simulate-Checkout in sandbox and maps finalAmount to cents", async () => {
    fetchMock.mockResolvedValueOnce(reply({ id: "chk_1", status: "PROCESSING", finalAmount: { amount: 15.69, currency: "SGD" } }));

    const checkout = await reapAdapter.createCheckout(input);
    expect(checkout).toEqual({ id: "chk_1", status: "PROCESSING", finalAmount: { amount: 1569, currency: "SGD" } });

    const req = sent();
    expect(req).toMatchObject({ method: "POST", url: `${BASE}/agentic/checkouts` });
    expect(req.headers["X-Simulate-Checkout"]).toBe("COMPLETED");
    expect(req.headers["Idempotency-Key"]).toBe("envelope-hash-123");
    expect(req.body).toEqual({
      quoteId: BOOK_QUOTE.id,
      enrollmentId: "enr_test",
      presentation: { type: "REDIRECT", returnUrl: input.returnUrl },
    });
  });

  it("falls back to `amount` and keeps the hosted approval link", async () => {
    fetchMock.mockResolvedValueOnce(
      reply({
        id: "chk_2",
        status: "REQUIRES_ACTION",
        amount: { amount: 58, currency: "USD" },
        nextAction: { url: "https://pay.example/approve", expiresAt: "2026-10-09T12:30:00.000Z" },
      }),
    );
    expect(await reapAdapter.createCheckout(input)).toEqual({
      id: "chk_2",
      status: "REQUIRES_ACTION",
      finalAmount: { amount: 5800, currency: "USD" },
      nextAction: { url: "https://pay.example/approve", expiresAt: "2026-10-09T12:30:00.000Z" },
    });
  });

  it("getCheckout maps orderId once Reap reports COMPLETED", async () => {
    fetchMock.mockResolvedValueOnce(
      reply({ id: "chk_1", status: "COMPLETED", orderId: "ord_123", finalAmount: { amount: 15.69, currency: "SGD" } }),
    );
    expect(await reapAdapter.getCheckout("chk_1")).toEqual({
      id: "chk_1",
      status: "COMPLETED",
      orderId: "ord_123",
      finalAmount: { amount: 1569, currency: "SGD" },
    });
    expect(sent()).toMatchObject({ method: "GET", url: `${BASE}/agentic/checkouts/chk_1` });
  });
});

describe("Reap errors", () => {
  it("turns { error: { code, message } } into a ReapError with that code", async () => {
    fetchMock.mockResolvedValueOnce(reply({ error: { code: "CHECKOUT_NOT_FOUND", message: "Checkout not found" } }, 404));
    const err = await reapAdapter.getCheckout("missing").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReapError);
    expect(err).toMatchObject({ status: 404, code: "CHECKOUT_NOT_FOUND", message: "Checkout not found" });
  });

  it("does not record a quote Reap refused (the brewlander 503)", async () => {
    fetchMock.mockResolvedValueOnce(
      reply({ error: { code: "AGENTIC_SERVICE_UNAVAILABLE", message: "Service unavailable" } }, 503),
    );
    await expect(quoteBook()).rejects.toMatchObject({ name: "ReapError", status: 503, code: "AGENTIC_SERVICE_UNAVAILABLE" });
    expect(db().prepare(`SELECT COUNT(*) AS n FROM reap_quotes`).get()).toEqual({ n: 0 });
  });
});
