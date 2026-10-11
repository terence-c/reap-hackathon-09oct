// X-Simulate-Checkout is a sandbox-only header. With a non-sandbox REAP_BASE_URL it must never be
// sent, even with REAP_SIMULATE_CHECKOUT=true. Own file: the REAP_* env group is cached per module graph.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { reapAdapter } from "@/lib/reap";
import { isSandboxBaseUrl, reapFetch } from "@/lib/reap/client";

vi.hoisted(() => {
  process.env.REAP_MODE = "live"; // these tests exercise the live adapter (fetch is stubbed)
  process.env.REAP_API_KEY = "test";
  process.env.REAP_BASE_URL = "https://sg.api.reap.global"; // production-shaped host
  process.env.REAP_SIMULATE_CHECKOUT = "true";
});

let fetchMock: Mock;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "chk_1", status: "REQUIRES_ACTION" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function headersSent(i = 0) {
  return (fetchMock.mock.calls[i] as [URL, RequestInit])[1].headers as Record<string, string>;
}

describe("X-Simulate-Checkout outside the sandbox", () => {
  it("createCheckout does not send it", async () => {
    await reapAdapter.createCheckout({
      quoteId: "q1",
      enrollmentId: "enr_1",
      returnUrl: "https://localhost:3443/orders/done",
      idempotencyKey: "k1",
    });
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://sg.api.reap.global/agentic/checkouts");
    expect(headersSent()["X-Simulate-Checkout"]).toBeUndefined();
    expect(headersSent()["Idempotency-Key"]).toBe("k1");
  });

  it("reapFetch drops it even if a caller asks for it", async () => {
    await reapFetch("/agentic/checkouts", { method: "POST", body: {}, simulateCheckout: true });
    expect(headersSent()["X-Simulate-Checkout"]).toBeUndefined();
  });
});

describe("isSandboxBaseUrl", () => {
  it.each([
    ["https://sg.sandbox.api.reap.global", true],
    ["https://sg.sandbox.api.reap.global/", true],
    ["https://SG.SANDBOX.API.REAP.GLOBAL", true],
    ["https://sg.api.reap.global", false],
    ["https://api.reap.global/sandbox", false], // "sandbox" in the path is not a sandbox host
    ["https://api.reap.global/?env=sandbox", false],
    ["https://sandbox.evil.example", false], // not Reap
    ["https://sandbox.reap.global.evil.example", false],
    ["http://sg.sandbox.api.reap.global", false], // never over plain http
    ["not a url", false],
  ])("%s → %s", (url, expected) => {
    expect(isSandboxBaseUrl(url)).toBe(expected);
  });
});
