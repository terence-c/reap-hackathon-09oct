import { beforeEach, describe, expect, it } from "vitest";
import demoMandate from "@/lib/mandate.demo.json";
import type { Disposition, Mandate } from "@/lib/types";
import { append, GENESIS_HASH, list, markExecuted, tamperForDemo, verifyChain } from "@/lib/safr/audit";
import { db, openInMemoryDb } from "@/lib/safr/db";
import { buildEnvelope, signEnvelope } from "@/lib/safr/envelope";
import { fakeQuote, item, START } from "./helpers";

const deny: Disposition = { decision: "DENY", rulesFired: ["CATEGORY_OUT_OF_SCOPE"], reason: "no" };
const auto: Disposition = { decision: "AUTO_EXECUTE", rulesFired: [], reason: "yes" };

function envelope(sku: string) {
  return signEnvelope(
    buildEnvelope({
      quote: fakeQuote(sku),
      catalogItem: item(sku),
      quantity: 1,
      mandate: demoMandate as Mandate,
      agent: { agentId: "purchasing-agent-v1", model: "m", promptHash: "p" },
      sessionId: "s1",
      toolTrace: [],
      agentReason: "",
    }),
    undefined,
  );
}

describe("audit chain", () => {
  beforeEach(() => {
    openInMemoryDb();
    append({ envelope: envelope("popular-ghost-stories-12"), disposition: auto, now: START });
    append({ envelope: envelope("brewlander-6pack"), disposition: deny, now: START + 1000 });
    append({ envelope: envelope("byndartisan-luggage-tag"), disposition: auto, now: START + 2000 });
  });

  it("links each entry to the previous hash", () => {
    const entries = list();
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(entries[0].prevHash).toBe(GENESIS_HASH);
    expect(entries[1].prevHash).toBe(entries[0].hash);
    expect(entries[2].prevHash).toBe(entries[1].hash);
    expect(verifyChain()).toEqual({ ok: true, length: 3 });
  });

  it("recording execution status does not break the chain", () => {
    markExecuted(1, "chk_1");
    expect(list()[0]).toMatchObject({ executed: true, checkoutId: "chk_1" });
    expect(verifyChain().ok).toBe(true);
  });

  it("editing an amount inside a stored envelope breaks the chain at that row", () => {
    expect(tamperForDemo(2)).toBe(2);
    expect(verifyChain()).toEqual({ ok: false, length: 3, brokenAtSeq: 2 });
  });

  it("rewriting a decision breaks the chain", () => {
    db().prepare(`UPDATE audit SET decision = 'AUTO_EXECUTE' WHERE seq = 2`).run();
    expect(verifyChain()).toMatchObject({ ok: false, brokenAtSeq: 2 });
  });

  it("deleting a row breaks the chain at the next one", () => {
    db().prepare(`DELETE FROM audit WHERE seq = 2`).run();
    expect(verifyChain()).toMatchObject({ ok: false, brokenAtSeq: 3 });
  });
});
