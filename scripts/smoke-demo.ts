// npm run smoke — the demo script end to end through the real gate and the real Reap sandbox.
// Uses an in-memory SAFR database (the app's data/safr.db is untouched) and registers the public
// key derived from AGENT_PRIVATE_KEY. Needs REAP_API_KEY, an ACTIVE REAP_ENROLLMENT_ID and
// AGENT_PRIVATE_KEY in .env.local. Creates real sandbox checkouts (simulated completion).

import "./load-env";
import catalog from "../lib/catalog.json";
import { env } from "../lib/env";
import { activeEnrollmentId } from "../lib/reap/enrollments";
import { reapAdapter } from "../lib/reap";
import { DEMO_SHIPPING_ADDRESS } from "../lib/reap/quotes";
import * as audit from "../lib/safr/audit";
import { openInMemoryDb } from "../lib/safr/db";
import { formatMoney } from "../lib/safr/disposition";
import { publicKeyFromPrivate } from "../lib/safr/envelope";
import { createGate, recordCheckoutOutcome } from "../lib/safr/gate";
import { registerPublicKey, setAgentStatus } from "../lib/safr/registry";
import type { CatalogItem, Decision, ProposeCheckoutResult } from "../lib/types";

type Row = { step: string; expected: string; got: string; ok: boolean | "skip" };
const rows: Row[] = [];
const items = catalog as CatalogItem[];
const SESSION = `smoke-${Date.now()}`;

function rules(result: ProposeCheckoutResult) {
  return audit.latestForEnvelope(result.envelopeHash)?.disposition.rulesFired.join(",") ?? "-";
}

async function settle(result: ProposeCheckoutResult): Promise<string> {
  if (!result.checkoutId) return `no checkout (${result.message})`;
  const final = await reapAdapter.pollCheckout(result.checkoutId, { intervalMs: 2000, timeoutMs: 90_000 });
  recordCheckoutOutcome(final.id, final.status);
  return `${final.status}${final.orderId ? ` order ${final.orderId}` : ""}${final.finalAmount ? ` ${formatMoney(final.finalAmount)}` : ""}`;
}

async function main() {
  if (!env.AGENT_PRIVATE_KEY) throw new Error("AGENT_PRIVATE_KEY is empty: run npm run keygen");
  if (!activeEnrollmentId()) throw new Error("No ACTIVE card: use Add card in the app or npm run enroll");

  openInMemoryDb();
  registerPublicKey(env.AGENT_ID, publicKeyFromPrivate(env.AGENT_PRIVATE_KEY));
  const gate = createGate({ reap: reapAdapter });

  async function propose(sku: string) {
    const item = items.find((i) => i.sku === sku)!;
    const quote = await reapAdapter.createQuote({ item, quantity: 1, email: env.DEMO_EMAIL, shippingAddress: DEMO_SHIPPING_ADDRESS });
    const result = await gate.proposeCheckout({ quoteId: quote.id, reason: `smoke test: ${sku}`, sessionId: SESSION });
    return { quote, result };
  }

  async function step(name: string, sku: string, expected: Decision, expectedRule?: string, after?: (r: ProposeCheckoutResult) => Promise<string>) {
    try {
      const { quote, result } = await propose(sku);
      const fired = rules(result);
      const ok = result.decision === expected && (!expectedRule || fired.includes(expectedRule));
      const extra = after ? ` · ${await after(result)}` : "";
      rows.push({ step: name, expected: `${expected}${expectedRule ? ` ${expectedRule}` : ""}`, got: `${result.decision} [${fired}] ${formatMoney(quote.finalAmount)}${extra}`, ok });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const reapDown = /AGENTIC_SERVICE_UNAVAILABLE|503/.test(message) || (err as { code?: string }).code === "AGENTIC_SERVICE_UNAVAILABLE";
      rows.push({ step: name, expected, got: `quote failed: ${message}`, ok: reapDown ? "skip" : false });
      return null;
    }
  }

  await step("1 book S$10.79", "popular-ghost-stories-12", "AUTO_EXECUTE", undefined, settle);

  const tag = await step("2 luggage tag S$85", "byndartisan-luggage-tag", "ESCALATE", "OVER_AUTO_THRESHOLD");
  if (tag?.decision === "ESCALATE") {
    const approved = await gate.approve(tag.envelopeHash, "smoke test");
    rows.push({ step: "2b approve tag", expected: "AUTO_EXECUTE HUMAN_APPROVED", got: `${approved.decision} [${rules(approved)}] · ${await settle(approved)}`, ok: approved.decision === "AUTO_EXECUTE" });
  }

  await step("3 table S$699", "picketandrail-geometry-table", "DENY", "OVER_HARD_CAP");
  await step("4 laptop stand US$58", "zmdesktop-laptop-stand", "DENY", "CURRENCY_MISMATCH");
  await step("5 beer S$33", "brewlander-6pack", "DENY", "CATEGORY_OUT_OF_SCOPE");
  await step("6 book again", "popular-ghost-stories-12", "OBSERVE", "VELOCITY", settle);

  setAgentStatus(env.AGENT_ID, "REVOKED");
  await step("7 revoked agent", "ergotune-pegboard", "DENY", "IDENTITY_REVOKED");
  setAgentStatus(env.AGENT_ID, "ACTIVE");

  const before = audit.verifyChain();
  audit.tamperForDemo(1);
  const after = audit.verifyChain();
  rows.push({ step: "8 tamper row 1", expected: "chain ok → broken at 1", got: `${before.ok ? "ok" : "broken"} → ${after.ok ? "ok" : `broken at ${after.brokenAtSeq}`}`, ok: before.ok && !after.ok && after.brokenAtSeq === 1 });

  for (const r of rows) console.log(`${r.ok === true ? "PASS" : r.ok === "skip" ? "SKIP" : "FAIL"}  ${r.step.padEnd(22)} expected ${r.expected.padEnd(34)} got ${r.got}`);
  if (rows.some((r) => r.ok === false)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
