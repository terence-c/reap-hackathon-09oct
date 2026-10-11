import { beforeEach, describe, expect, it } from "vitest";
import {
  getReservation,
  loadMandate,
  MandateSchema,
  recentPurchaseCount,
  releaseReservation,
  remainingBudget,
  reserve,
  saveMandate,
  settle,
  VELOCITY_WINDOW_MS,
} from "@/lib/safr/controls";
import { db, openInMemoryDb } from "@/lib/safr/db";
import { MINUTE, START } from "./helpers";

const SGD = (amount: number) => ({ amount, currency: "SGD" as const });

describe("controls repository", () => {
  beforeEach(() => openInMemoryDb());

  it("seeds the demo mandate", () => {
    expect(loadMandate()).toMatchObject({
      id: "mandate-001",
      version: 1,
      currency: "SGD",
      totalBudget: 15000,
      autoThreshold: 8000,
      allowedCategories: ["Office & Business Supplies", "Books & Stationery"],
      killSwitch: false,
    });
  });

  it("saveMandate validates and bumps the version", () => {
    const saved = saveMandate({ ...loadMandate(), killSwitch: true });
    expect(saved.version).toBe(2);
    expect(loadMandate()).toMatchObject({ version: 2, killSwitch: true });
    expect(() => saveMandate({ ...loadMandate(), totalBudget: 12.5 })).toThrow();
  });

  it("saveMandate enforces autoThreshold ≤ totalBudget and validFrom < validTo", () => {
    const current = loadMandate();
    expect(() => saveMandate({ ...current, totalBudget: 5000, autoThreshold: 8000 })).toThrow(/autoThreshold must be at or below totalBudget/);
    expect(() => saveMandate({ ...current, validTo: current.validFrom })).toThrow(/validFrom must be before validTo/);
    expect(() => saveMandate({ ...current, validFrom: "2026-12-01T00:00:00Z", validTo: "2026-11-01T00:00:00Z" })).toThrow(
      /validFrom must be before validTo/,
    );
    expect(loadMandate().version).toBe(1); // nothing saved
    expect(saveMandate({ ...current, autoThreshold: current.totalBudget }).autoThreshold).toBe(current.totalBudget); // equal is fine
  });

  it("loadMandate still reads a row saved before the cross-field rules existed", () => {
    db().prepare(`UPDATE mandates SET json = ?`).run(JSON.stringify({ ...loadMandate(), totalBudget: 5000, autoThreshold: 8000 }));
    expect(loadMandate()).toMatchObject({ totalBudget: 5000, autoThreshold: 8000 });
    expect(MandateSchema.safeParse(loadMandate()).success).toBe(false);
  });

  it("remaining budget counts reserved and settled, not released", () => {
    reserve("h1", { mandateId: "mandate-001", merchantDomain: "popular.com.sg", amount: SGD(1579) }, START);
    reserve("h2", { mandateId: "mandate-001", merchantDomain: "byndartisan.com", amount: SGD(9000) }, START);
    reserve("h3", { mandateId: "mandate-001", merchantDomain: "ergotune.com", amount: SGD(6400) }, START);
    settle("h1");
    releaseReservation("h3");
    expect(remainingBudget("mandate-001")).toBe(15000 - 1579 - 9000);
    expect(remainingBudget("mandate-001", { excludeEnvelopeHash: "h2" })).toBe(15000 - 1579);
  });

  it("release never undoes a settlement; settle wins over a release", () => {
    reserve("h1", { mandateId: "mandate-001", merchantDomain: "popular.com.sg", amount: SGD(1579) }, START);
    settle("h1");
    expect(releaseReservation("h1")).toBe(false);
    expect(getReservation("h1")?.status).toBe("SETTLED");
    reserve("h2", { mandateId: "mandate-001", merchantDomain: "popular.com.sg", amount: SGD(1579) }, START);
    releaseReservation("h2");
    settle("h2"); // Reap completed after we gave up waiting: the money is spent
    expect(getReservation("h2")?.status).toBe("SETTLED");
  });

  it("reserve is idempotent per envelope", () => {
    reserve("h1", { mandateId: "mandate-001", merchantDomain: "popular.com.sg", amount: SGD(1579) }, START);
    reserve("h1", { mandateId: "mandate-001", merchantDomain: "popular.com.sg", amount: SGD(1579) }, START);
    expect(remainingBudget("mandate-001")).toBe(15000 - 1579);
  });

  it("velocity counts same-merchant purchases inside the 15-minute window only", () => {
    expect(VELOCITY_WINDOW_MS).toBe(15 * MINUTE);
    reserve("h1", { mandateId: "mandate-001", merchantDomain: "popular.com.sg", amount: SGD(1579) }, START);
    // Default window and clock arguments: the constant is what the gate uses.
    expect(recentPurchaseCount("popular.com.sg", undefined, START + 14 * MINUTE)).toBe(1);
    expect(recentPurchaseCount("popular.com.sg", undefined, START + 15 * MINUTE - 1)).toBe(1);
    expect(recentPurchaseCount("popular.com.sg", undefined, START + 15 * MINUTE)).toBe(0); // strict: created_at > now − window
    expect(recentPurchaseCount("popular.com.sg", undefined, START + 16 * MINUTE)).toBe(0);
    expect(recentPurchaseCount("ergotune.com", undefined, START + MINUTE)).toBe(0);
    releaseReservation("h1");
    expect(recentPurchaseCount("popular.com.sg", undefined, START + MINUTE)).toBe(0);
  });
});
