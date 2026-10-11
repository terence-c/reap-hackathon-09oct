// The stored Reap card enrollment: which one the app shows and charges, and refreshing pending
// ones from Reap (fetch stubbed, no network).

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  activeEnrollmentId,
  createEnrollment,
  currentEnrollment,
  refreshPendingEnrollments,
  rememberEnrollment,
} from "@/lib/reap/enrollments";
import { openInMemoryDb } from "@/lib/safr/db";

// env validates the REAP_* group on first access and caches it, so set it before anything runs.
vi.hoisted(() => {
  process.env.REAP_MODE = "live"; // these tests exercise the live adapter (fetch is stubbed)
  process.env.REAP_API_KEY = "test";
  process.env.REAP_BASE_URL = "https://sg.sandbox.api.reap.global";
  process.env.REAP_ENROLLMENT_ID = "enr_from_env";
});

const T0 = Date.parse("2026-10-09T12:00:00+08:00");
const OWNER = "demo-user-001";

let fetchMock: Mock;

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function at(ms: number) {
  vi.setSystemTime(ms);
}

beforeEach(() => {
  openInMemoryDb();
  vi.useFakeTimers({ toFake: ["Date"] });
  at(T0);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("which card", () => {
  it("activeEnrollmentId falls back to REAP_ENROLLMENT_ID when no card is ACTIVE in the app", () => {
    expect(activeEnrollmentId()).toBe("enr_from_env");
    rememberEnrollment({ id: "enr_pending", status: "REQUIRES_ACTION", url: "https://reap.example/card/1" }, OWNER);
    rememberEnrollment({ id: "enr_failed", status: "FAILED" }, OWNER);
    expect(activeEnrollmentId()).toBe("enr_from_env");
    rememberEnrollment({ id: "enr_active", status: "ACTIVE" }, OWNER);
    expect(activeEnrollmentId()).toBe("enr_active");
  });

  it("currentEnrollment prefers an ACTIVE card over a newer pending one", () => {
    expect(currentEnrollment()).toBeNull();
    rememberEnrollment({ id: "enr_active", status: "ACTIVE" }, OWNER);
    at(T0 + 60_000);
    rememberEnrollment({ id: "enr_new_pending", status: "REQUIRES_ACTION", url: "https://reap.example/card/2" }, OWNER);
    expect(currentEnrollment()).toMatchObject({ id: "enr_active", status: "ACTIVE" });
    expect(activeEnrollmentId()).toBe("enr_active");
  });

  it("with no ACTIVE card, the newest created one wins even if an older one was refreshed later", () => {
    rememberEnrollment({ id: "enr_old", status: "REQUIRES_ACTION", url: "https://reap.example/card/old" }, OWNER);
    at(T0 + 60_000);
    rememberEnrollment({ id: "enr_new", status: "REQUIRES_ACTION", url: "https://reap.example/card/new" }, OWNER);
    at(T0 + 120_000);
    rememberEnrollment({ id: "enr_old", status: "REQUIRES_ACTION" }, OWNER); // a refresh re-stamps updated_at
    expect(currentEnrollment()).toMatchObject({ id: "enr_new", url: "https://reap.example/card/new" });
  });

  it("of two ACTIVE cards, the newest created is charged", () => {
    rememberEnrollment({ id: "enr_first", status: "ACTIVE" }, OWNER);
    at(T0 + 60_000);
    rememberEnrollment({ id: "enr_second", status: "ACTIVE" }, OWNER);
    at(T0 + 120_000);
    rememberEnrollment({ id: "enr_first", status: "ACTIVE" }, OWNER);
    expect(activeEnrollmentId()).toBe("enr_second");
    expect(currentEnrollment()?.id).toBe("enr_second");
  });
});

describe("refreshPendingEnrollments", () => {
  it("re-reads only pending enrollments and stores what Reap says; one failure doesn't stop the rest", async () => {
    rememberEnrollment({ id: "enr_a", status: "REQUIRES_ACTION", url: "https://reap.example/card/a" }, OWNER);
    rememberEnrollment({ id: "enr_b", status: "REQUIRES_ACTION", url: "https://reap.example/card/b" }, OWNER);
    rememberEnrollment({ id: "enr_c", status: "REQUIRES_ACTION", url: "https://reap.example/card/c" }, OWNER);
    rememberEnrollment({ id: "enr_done", status: "EXPIRED" }, OWNER);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    fetchMock.mockImplementation(async (url: URL | string) => {
      const id = String(url).split("/").pop();
      if (id === "enr_a") return reply({ id: "enr_a", status: "ACTIVE" });
      if (id === "enr_b") return reply({ id: "enr_b", status: "EXPIRED" });
      return reply({ error: { code: "INTERNAL", message: "boom" } }, 500);
    });

    await refreshPendingEnrollments();

    const urls = fetchMock.mock.calls.map(([url]) => String(url)).sort();
    expect(urls).toEqual([
      "https://sg.sandbox.api.reap.global/agentic/enrollments/enr_a",
      "https://sg.sandbox.api.reap.global/agentic/enrollments/enr_b",
      "https://sg.sandbox.api.reap.global/agentic/enrollments/enr_c",
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(currentEnrollment()).toMatchObject({ id: "enr_a", status: "ACTIVE" });
    expect(activeEnrollmentId()).toBe("enr_a");

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(reply({ id: "enr_c", status: "REQUIRES_ACTION", nextAction: { url: "https://reap.example/card/c" } }));
    await refreshPendingEnrollments();
    expect(fetchMock).toHaveBeenCalledTimes(1); // only enr_c is still pending
  });
});

describe("createEnrollment", () => {
  it("returns the enrollment it just created, with its card page, even when a card is already ACTIVE", async () => {
    rememberEnrollment({ id: "enr_active", status: "ACTIVE", url: "https://reap.example/card/used" }, OWNER);
    fetchMock.mockResolvedValueOnce(
      reply({ id: "enr_new", status: "REQUIRES_ACTION", nextAction: { url: "https://reap.example/card/new" } }),
    );
    const created = await createEnrollment({ ownerId: OWNER, email: "demo@example.com", returnUrl: "https://localhost:3443/orders/enrollment-done" });
    expect(created).toMatchObject({ id: "enr_new", status: "REQUIRES_ACTION", url: "https://reap.example/card/new" });
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      source: "EXTERNAL",
      owner: { type: "CLIENT_REFERENCE", id: OWNER, email: "demo@example.com" },
      presentation: { type: "REDIRECT", returnUrl: "https://localhost:3443/orders/enrollment-done" },
    });
  });

  it("refuses an http:// return URL before calling Reap", async () => {
    await expect(
      createEnrollment({ ownerId: OWNER, email: "demo@example.com", returnUrl: "http://localhost:3000/orders/enrollment-done" }),
    ).rejects.toThrow(/must be HTTPS/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
