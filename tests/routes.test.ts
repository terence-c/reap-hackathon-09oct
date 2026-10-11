// Route handlers called directly with a NextRequest: no server, no network (fetch is stubbed).
// The gate state is built with the test gate from ./helpers; the routes share its in-memory DB.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { connection, NextRequest } from "next/server";
import * as audit from "@/lib/safr/audit";
import { getReservation, loadMandate } from "@/lib/safr/controls";
import { getAgent } from "@/lib/safr/registry";
import { APPROVAL_WINDOW_MS } from "@/lib/safr/windows";
import { AGENT_ID, setup, START } from "./helpers";

import * as approvalsRoute from "@/app/api/approvals/route";
import * as auditRoute from "@/app/api/audit/route";
import * as checkoutRoute from "@/app/api/checkout/route";
import * as enrollmentRoute from "@/app/api/enrollment/route";
import * as mandateRoute from "@/app/api/mandate/route";
import * as registryRoute from "@/app/api/registry/route";

vi.hoisted(() => {
  process.env.REAP_MODE = "live"; // these tests exercise the live adapter (fetch is stubbed)
  process.env.REAP_API_KEY = "test";
  process.env.REAP_BASE_URL = "https://sg.sandbox.api.reap.global";
  // The routes use the module-level gate, which reads Date.now (captured when lib/safr/gate loads).
  // Fake Date before any import so that clock is the test clock (helpers' START), not the real one.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-10-09T12:00:00+08:00"));
});

// Keep the real next/server, but make connection() observable.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: vi.fn(async () => {}),
}));

const ORIGIN = "https://localhost:3443";

function get(path: string) {
  return new NextRequest(`${ORIGIN}${path}`);
}

function post(path: string, body: unknown, headers: Record<string, string> = { origin: ORIGIN, host: "localhost:3443" }) {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let fetchMock: Mock;

beforeEach(() => {
  fetchMock = vi.fn(async () => {
    throw new Error("unexpected network call");
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.mocked(connection).mockClear();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function propose(env: ReturnType<typeof setup>, sku: string) {
  const q = await env.quote(sku);
  return env.gate.proposeCheckout({ quoteId: q.id, reason: "", sessionId: "s" });
}

describe("dynamic GET handlers call connection() so they are never cached", () => {
  it.each([
    ["approvals", () => approvalsRoute.GET()],
    ["audit", () => auditRoute.GET()],
    ["mandate", () => mandateRoute.GET()],
    ["registry", () => registryRoute.GET(get("/api/registry"))],
    ["enrollment", () => enrollmentRoute.GET()],
    ["checkout", () => checkoutRoute.GET(get("/api/checkout"))],
  ])("%s", async (_name, call) => {
    setup();
    await call();
    expect(connection).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/checkout", () => {
  it("400 without a valid envelopeHash or checkoutId", async () => {
    setup();
    expect((await checkoutRoute.GET(get("/api/checkout"))).status).toBe(400);
    expect((await checkoutRoute.GET(get("/api/checkout?envelopeHash=nothex"))).status).toBe(400);
    expect((await checkoutRoute.GET(get("/api/checkout?checkoutId=bad%20id"))).status).toBe(400);
  });

  it("404 for a denied envelope (it never reached Reap), a pending one and an unknown one", async () => {
    const env = setup();
    const beer = await propose(env, "brewlander-6pack");
    const tag = await propose(env, "byndartisan-luggage-tag");
    expect(beer.decision).toBe("DENY");
    for (const hash of [beer.envelopeHash, tag.envelopeHash, "0".repeat(64)]) {
      const res = await checkoutRoute.GET(get(`/api/checkout?envelopeHash=${hash}`));
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads Reap's status and records it: COMPLETED settles the hold", async () => {
    const env = setup();
    const book = await propose(env, "popular-ghost-stories-12");
    fetchMock.mockResolvedValueOnce(
      reply({ id: book.checkoutId, status: "COMPLETED", orderId: "ord_1", finalAmount: { amount: 15.79, currency: "SGD" } }),
    );
    const res = await checkoutRoute.GET(get(`/api/checkout?envelopeHash=${book.envelopeHash}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      checkoutId: book.checkoutId,
      status: "COMPLETED",
      orderId: "ord_1",
      finalAmount: { amount: 1579, currency: "SGD" },
      envelopeHash: book.envelopeHash,
    });
    expect(String(fetchMock.mock.calls[0][0])).toBe(`https://sg.sandbox.api.reap.global/agentic/checkouts/${book.checkoutId}`);
    expect(getReservation(book.envelopeHash)?.status).toBe("SETTLED");
  });

  it("REQUIRES_ACTION keeps the hold; FAILED by checkoutId releases it and maps back to the envelope", async () => {
    const env = setup();
    const book = await propose(env, "popular-ghost-stories-12");
    fetchMock.mockResolvedValueOnce(reply({ id: book.checkoutId, status: "REQUIRES_ACTION", nextAction: { url: "https://reap.example/approve" } }));
    const pending = await (await checkoutRoute.GET(get(`/api/checkout?envelopeHash=${book.envelopeHash}`))).json();
    expect(pending).toMatchObject({ status: "REQUIRES_ACTION" });
    expect(pending.orderId).toBeUndefined();
    expect(getReservation(book.envelopeHash)?.status).toBe("RESERVED");

    fetchMock.mockResolvedValueOnce(reply({ id: book.checkoutId, status: "FAILED" }));
    const failed = await (await checkoutRoute.GET(get(`/api/checkout?checkoutId=${book.checkoutId}`))).json();
    expect(failed).toMatchObject({ status: "FAILED", envelopeHash: book.envelopeHash });
    expect(getReservation(book.envelopeHash)?.status).toBe("RELEASED");
  });

  it("502 when Reap can't be read, and nothing changes", async () => {
    const env = setup();
    const book = await propose(env, "popular-ghost-stories-12");
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(reply({ error: { code: "INVALID_API_KEY", message: "Invalid API key" } }, 401));
    const res = await checkoutRoute.GET(get(`/api/checkout?envelopeHash=${book.envelopeHash}`));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("INVALID_API_KEY");
    expect(getReservation(book.envelopeHash)?.status).toBe("RESERVED");
  });

  it("a simulated checkout reports COMPLETED without calling Reap and settles the hold", async () => {
    const env = setup({
      gate: {
        simulateWithoutCard: () => true,
        enrollmentId: () => {
          throw new Error("no card");
        },
      },
    });
    const book = await propose(env, "popular-ghost-stories-12");
    const body = await (await checkoutRoute.GET(get(`/api/checkout?envelopeHash=${book.envelopeHash}`))).json();
    expect(body).toMatchObject({ checkoutId: book.checkoutId, status: "COMPLETED", simulated: true, envelopeHash: book.envelopeHash });
    expect(body.orderId).toMatch(/^SIMULATED-/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getReservation(book.envelopeHash)?.status).toBe("SETTLED");
  });
});

describe("POST /api/mandate", () => {
  function body(overrides: Record<string, unknown> = {}) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { version, ...mandate } = loadMandate();
    return { ...mandate, ...overrides };
  }

  it("400 when autoThreshold is above totalBudget", async () => {
    setup();
    const res = await mandateRoute.POST(post("/api/mandate", body({ totalBudget: 5000, autoThreshold: 8000 })));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("autoThreshold: autoThreshold must be at or below totalBudget");
    expect(loadMandate().version).toBe(1);
  });

  it("400 when validFrom is not before validTo", async () => {
    setup();
    const same = await mandateRoute.POST(post("/api/mandate", body({ validFrom: "2026-10-10T00:00:00Z", validTo: "2026-10-10T00:00:00Z" })));
    expect(same.status).toBe(400);
    expect((await same.json()).error).toBe("validTo: validFrom must be before validTo");
    const reversed = await mandateRoute.POST(post("/api/mandate", body({ validFrom: "2026-10-11T00:00:00Z", validTo: "2026-10-10T00:00:00Z" })));
    expect(reversed.status).toBe(400);
    expect(loadMandate().version).toBe(1);
  });

  it("400 for bad JSON or a fractional amount; 404 for another mandate id", async () => {
    setup();
    const bad = new NextRequest(`${ORIGIN}/api/mandate`, { method: "POST", body: "{not json" });
    expect((await mandateRoute.POST(bad)).status).toBe(400);
    expect((await mandateRoute.POST(post("/api/mandate", body({ totalBudget: 120.5 })))).status).toBe(400);
    expect((await mandateRoute.POST(post("/api/mandate", body({ id: "mandate-999" })))).status).toBe(404);
  });

  it("saves a valid mandate (threshold equal to the budget is fine) and bumps the version", async () => {
    setup();
    const res = await mandateRoute.POST(post("/api/mandate", body({ totalBudget: 10000, autoThreshold: 10000, killSwitch: true })));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mandate: { version: 2, killSwitch: true }, remaining: 10000 });
  });

  it("refuses a cross-site browser request; allows curl (no Origin)", async () => {
    setup();
    const cross = await mandateRoute.POST(post("/api/mandate", body({ killSwitch: true }), { origin: "https://evil.example", host: "localhost:3443" }));
    expect(cross.status).toBe(403);
    expect(loadMandate().killSwitch).toBe(false);
    const curl = await mandateRoute.POST(post("/api/mandate", body({ killSwitch: true }), { host: "localhost:3443" }));
    expect(curl.status).toBe(200);
    expect(loadMandate().killSwitch).toBe(true);
  });

  it("GET releases a timed-out escalation before reporting what's left", async () => {
    const env = setup();
    await propose(env, "byndartisan-luggage-tag");
    expect(await (await mandateRoute.GET()).json()).toMatchObject({ reserved: 9000, remaining: 6000 });
    vi.setSystemTime(START + APPROVAL_WINDOW_MS);
    expect(await (await mandateRoute.GET()).json()).toMatchObject({ reserved: 0, remaining: 15000 });
  });
});

describe("POST /api/approvals", () => {
  it("decline then decline again → 409; approve after → 409", async () => {
    const env = setup();
    const fresh = await propose(env, "byndartisan-luggage-tag");
    expect(fresh.decision).toBe("ESCALATE");

    const first = await approvalsRoute.POST(post("/api/approvals", { envelopeHash: fresh.envelopeHash, action: "DECLINE", reviewer: "You" }));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ decision: "DENY", envelopeHash: fresh.envelopeHash });
    expect(getReservation(fresh.envelopeHash)?.status).toBe("RELEASED");

    const again = await approvalsRoute.POST(post("/api/approvals", { envelopeHash: fresh.envelopeHash, action: "DECLINE", reviewer: "You" }));
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "ALREADY_DECIDED" });
    const approve = await approvalsRoute.POST(post("/api/approvals", { envelopeHash: fresh.envelopeHash, action: "APPROVE", reviewer: "You" }));
    expect(approve.status).toBe(409);
  });

  it("404 for an unknown envelope, 400 for a bad body, 403 cross-site", async () => {
    setup();
    const unknown = await approvalsRoute.POST(post("/api/approvals", { envelopeHash: "a".repeat(64), action: "APPROVE", reviewer: "You" }));
    expect(unknown.status).toBe(404);
    expect((await approvalsRoute.POST(post("/api/approvals", { envelopeHash: "x", action: "APPROVE", reviewer: "You" }))).status).toBe(400);
    expect((await approvalsRoute.POST(post("/api/approvals", { envelopeHash: "a".repeat(64), action: "MAYBE", reviewer: "You" }))).status).toBe(400);
    const cross = await approvalsRoute.POST(
      post("/api/approvals", { envelopeHash: "a".repeat(64), action: "APPROVE", reviewer: "You" }, { origin: "https://evil.example", host: "localhost:3443" }),
    );
    expect(cross.status).toBe(403);
  });
});

describe("POST /api/registry", () => {
  it("a cross-site page can't restore a revoked agent; the app and curl can", async () => {
    setup();
    expect((await registryRoute.POST(post("/api/registry", { status: "REVOKED" }))).status).toBe(200);
    expect(getAgent(AGENT_ID)?.status).toBe("REVOKED");
    const cross = await registryRoute.POST(post("/api/registry", { status: "ACTIVE" }, { origin: "https://evil.example", host: "localhost:3443" }));
    expect(cross.status).toBe(403);
    expect(getAgent(AGENT_ID)?.status).toBe("REVOKED");
    expect((await registryRoute.POST(post("/api/registry", { status: "ACTIVE" }, { host: "localhost:3443" }))).status).toBe(200);
    expect(getAgent(AGENT_ID)?.status).toBe("ACTIVE");
    expect((await registryRoute.POST(post("/api/registry", { agentId: "nobody", status: "ACTIVE" }))).status).toBe(404);
  });
});

describe("GET /api/audit", () => {
  it("returns the entries and the chain check", async () => {
    const env = setup();
    await propose(env, "brewlander-6pack");
    const body = await (await auditRoute.GET()).json();
    expect(body.entries).toHaveLength(1);
    expect(body.chain).toEqual({ ok: true, length: 1 });
    audit.tamperForDemo();
    expect((await (await auditRoute.GET()).json()).chain).toMatchObject({ ok: false, brokenAtSeq: 1 });
  });
});
