import { beforeEach, describe, expect, it } from "vitest";
import {
  getReservation,
  loadMandate,
  recentPurchaseCount,
  releaseReservation,
  remainingBudget,
  reserve,
  saveMandate,
  settle,
} from "@/lib/safr/controls";
import { openInMemoryDb } from "@/lib/safr/db";
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

  it("velocity counts same-merchant purchases inside the 5-minute window only", () => {
    reserve("h1", { mandateId: "mandate-001", merchantDomain: "popular.com.sg", amount: SGD(1579) }, START);
    expect(recentPurchaseCount("popular.com.sg", 5 * MINUTE, START + 4 * MINUTE)).toBe(1);
    expect(recentPurchaseCount("popular.com.sg", 5 * MINUTE, START + 6 * MINUTE)).toBe(0);
    expect(recentPurchaseCount("ergotune.com", 5 * MINUTE, START + MINUTE)).toBe(0);
    releaseReservation("h1");
    expect(recentPurchaseCount("popular.com.sg", 5 * MINUTE, START + MINUTE)).toBe(0);
  });
});
