// Shared fixtures: a fresh in-memory SAFR DB, a registered agent keypair, a fixed clock inside
// the demo mandate's validity window, the mock Reap adapter and a gate wired to all of them.

import type { CatalogItem, Quote } from "@/lib/types";
import { openInMemoryDb } from "@/lib/safr/db";
import { generateAgentKeyPair } from "@/lib/safr/envelope";
import { CATALOG, createGate, DEMO_SHIPPING_ADDRESS } from "@/lib/safr/gate";
import { createMockReap } from "@/lib/safr/mock-reap";
import { getAgent, registerPublicKey } from "@/lib/safr/registry";

export const AGENT_ID = "purchasing-agent-v1";
export const START = Date.parse("2026-10-09T12:00:00+08:00");
export const MINUTE = 60_000;

export function item(sku: string): CatalogItem {
  const found = CATALOG.find((i) => i.sku === sku);
  if (!found) throw new Error(`no catalog item ${sku}`);
  return found;
}

export function fakeQuote(sku: string, overrides: Partial<Quote> = {}, now = START): Quote {
  const it = item(sku);
  const currency = it.unitPrice.currency;
  return {
    id: `q_${sku}`,
    merchantDomain: it.merchantDomain,
    itemsSubtotal: { amount: it.unitPrice.amount, currency },
    shipping: { amount: 500, currency },
    tax: { amount: 0, currency },
    finalAmount: { amount: it.unitPrice.amount + 500, currency },
    expiresAt: new Date(now + 10 * MINUTE).toISOString(),
    ...overrides,
  };
}

export function setup(opts: { privateKey?: string | null } = {}) {
  openInMemoryDb();
  const keys = generateAgentKeyPair();
  registerPublicKey(AGENT_ID, keys.publicKey);
  const clock = { t: START, advance: (ms: number) => (clock.t += ms) };
  const reap = createMockReap({ now: () => clock.t });
  const gate = createGate({
    reap,
    now: () => clock.t,
    agentId: AGENT_ID,
    privateKey: () => (opts.privateKey === null ? undefined : (opts.privateKey ?? keys.privateKey)),
    enrollmentId: () => "enr_test",
    appBaseUrl: () => "http://localhost:3000",
    email: () => "demo@agentcart.test",
  });
  // What C's getQuote tool does: quote one catalog item through the adapter.
  const quote = (sku: string, quantity = 1) =>
    reap.createQuote({ item: item(sku), quantity, email: "demo@agentcart.test", shippingAddress: DEMO_SHIPPING_ADDRESS });
  return { keys, clock, reap, gate, quote, agent: () => getAgent(AGENT_ID)! };
}
