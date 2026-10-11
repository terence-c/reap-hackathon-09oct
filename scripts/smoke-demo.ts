// npm run smoke — the demo script end to end through the real gate and the real Reap sandbox.
// Uses an in-memory SAFR database (the app's data/safr.db is untouched) and registers the public
// key derived from AGENT_PRIVATE_KEY. Needs REAP_API_KEY, an ACTIVE REAP_ENROLLMENT_ID and
// AGENT_PRIVATE_KEY in .env.local. Creates real sandbox checkouts. Every sandbox checkout waits
// for a human on Reap's hosted approval page, so a checkout that Reap reports as REQUIRES_ACTION
// or PROCESSING counts as a pass ("created at Reap, awaiting approval"), as does COMPLETED.
// Each checkout is read once (no long poll); FAILED or EXPIRED is a fail.
//
// REAP_MODE=mock npm run smoke — offline: recorded sandbox prices, checkouts COMPLETED in-process,
// no network, no REAP_API_KEY, and data/safr.db is never opened. An ephemeral agent key is used
// if AGENT_PRIVATE_KEY is empty.

import "./load-env";
import catalog from "../lib/catalog.json";
import { env } from "../lib/env";
import { activeEnrollmentId } from "../lib/reap/enrollments";
import { reapAdapter, reapMode } from "../lib/reap";
import { DEMO_SHIPPING_ADDRESS } from "../lib/reap/quotes";
import * as audit from "../lib/safr/audit";
import { openInMemoryDb } from "../lib/safr/db";
import { formatMoney } from "../lib/safr/disposition";
import { generateAgentKeyPair, publicKeyFromPrivate } from "../lib/safr/envelope";
import { createGate, recordCheckoutOutcome } from "../lib/safr/gate";
import { registerPublicKey, setAgentStatus } from "../lib/safr/registry";
import type { CatalogItem, Decision, ProposeCheckoutResult } from "../lib/types";

type Row = { step: string; expected: string; got: string; ok: boolean | "skip" };
type Check = { text: string; ok: boolean };
const rows: Row[] = [];
const items = catalog as CatalogItem[];
const SESSION = `smoke-${Date.now()}`;

function rules(result: ProposeCheckoutResult) {
  return audit.latestForEnvelope(result.envelopeHash)?.disposition.rulesFired.join(",") ?? "-";
}

// One status read, no long poll: the sandbox never completes a checkout without a human approving it.
async function checkCheckout(result: ProposeCheckoutResult): Promise<Check> {
  if (!result.checkoutId) return { text: `no checkout (${result.message})`, ok: false };
  try {
    const current = await reapAdapter.getCheckout(result.checkoutId);
    recordCheckoutOutcome(current.id, current.status);
    const amount = current.finalAmount ? ` ${formatMoney(current.finalAmount)}` : "";
    if (current.status === "COMPLETED") return { text: `COMPLETED${current.orderId ? ` order ${current.orderId}` : ""}${amount}`, ok: true };
    if (current.status === "REQUIRES_ACTION" || current.status === "PROCESSING")
      return { text: `${current.status}${amount}: checkout created at Reap, awaiting approval`, ok: true };
    return { text: `${current.status}${amount}`, ok: false };
  } catch (err) {
    return { text: `status check failed: ${err instanceof Error ? err.message : String(err)}`, ok: false };
  }
}

async function main() {
  const mock = reapMode() === "mock";
  console.log(`Reap mode: ${mock ? "mock (recorded sandbox prices, no network)" : "live (Reap sandbox)"}`);
  let privateKey = env.AGENT_PRIVATE_KEY;
  if (!privateKey) {
    if (!mock) throw new Error("AGENT_PRIVATE_KEY is empty: run npm run keygen");
    privateKey = generateAgentKeyPair().privateKey; // registered below, in the in-memory DB only
  }

  let enrollmentId: string | undefined;
  if (mock) {
    openInMemoryDb(); // first, so data/safr.db is never opened
    enrollmentId = activeEnrollmentId(); // REAP_ENROLLMENT_ID, else the mock enrollment
  } else {
    // Read the card from data/safr.db (or REAP_ENROLLMENT_ID) BEFORE switching to the in-memory DB,
    // which has no enrollments: otherwise every checkout would fail with "no card has been added yet".
    enrollmentId = activeEnrollmentId();
    if (!enrollmentId) throw new Error("No ACTIVE card: use Add card in the app or npm run enroll");
    openInMemoryDb();
  }
  const card = enrollmentId;
  const key = privateKey;
  registerPublicKey(env.AGENT_ID, publicKeyFromPrivate(key));
  const gate = createGate({
    reap: reapAdapter,
    privateKey: () => key,
    enrollmentId: () => {
      if (!card) throw new Error("no card");
      return card;
    },
    simulateWithoutCard: () => false,
  });

  async function propose(sku: string) {
    const item = items.find((i) => i.sku === sku)!;
    const quote = await reapAdapter.createQuote({ item, quantity: 1, email: env.DEMO_EMAIL, shippingAddress: DEMO_SHIPPING_ADDRESS });
    const result = await gate.proposeCheckout({ quoteId: quote.id, reason: `smoke test: ${sku}`, sessionId: SESSION });
    return { quote, result };
  }

  async function step(name: string, sku: string, expected: Decision, expectedRule?: string, after?: (r: ProposeCheckoutResult) => Promise<Check>) {
    try {
      const { quote, result } = await propose(sku);
      const fired = rules(result);
      const decided = result.decision === expected && (!expectedRule || fired.includes(expectedRule));
      const check = after ? await after(result) : null;
      const extra = check ? ` · ${check.text}` : "";
      const ok = decided && (check?.ok ?? true);
      rows.push({ step: name, expected: `${expected}${expectedRule ? ` ${expectedRule}` : ""}`, got: `${result.decision} [${fired}] ${formatMoney(quote.finalAmount)}${extra}`, ok });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const reapDown = /AGENTIC_SERVICE_UNAVAILABLE|503/.test(message) || (err as { code?: string }).code === "AGENTIC_SERVICE_UNAVAILABLE";
      rows.push({ step: name, expected, got: `quote failed: ${message}`, ok: reapDown ? "skip" : false });
      return null;
    }
  }

  await step("1 book S$10.79", "popular-ghost-stories-12", "AUTO_EXECUTE", undefined, checkCheckout);

  const tag = await step("2 luggage tag S$85", "byndartisan-luggage-tag", "ESCALATE", "OVER_AUTO_THRESHOLD");
  if (tag?.decision === "ESCALATE") {
    try {
      const approved = await gate.approve(tag.envelopeHash, "smoke test");
      const check = await checkCheckout(approved);
      rows.push({ step: "2b approve tag", expected: "AUTO_EXECUTE HUMAN_APPROVED", got: `${approved.decision} [${rules(approved)}] · ${check.text}`, ok: approved.decision === "AUTO_EXECUTE" && check.ok });
    } catch (err) {
      rows.push({ step: "2b approve tag", expected: "AUTO_EXECUTE HUMAN_APPROVED", got: `approve failed: ${err instanceof Error ? err.message : String(err)}`, ok: false });
    }
  }

  await step("3 table S$699", "picketandrail-geometry-table", "DENY", "OVER_HARD_CAP");
  await step("4 laptop stand US$58", "zmdesktop-laptop-stand", "DENY", "CURRENCY_MISMATCH");
  await step("5 beer S$33", "brewlander-6pack", "DENY", "CATEGORY_OUT_OF_SCOPE");
  await step("6 book again", "popular-ghost-stories-12", "OBSERVE", "VELOCITY", checkCheckout);

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
