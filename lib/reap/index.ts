// Lane A's ReapAdapter: the only object in the app that talks to Reap. B's gate gets it through
// lib/safr/reap-adapter.ts; nothing hands it to the LLM.
//
// REAP_MODE=live calls the Reap sandbox. REAP_MODE=mock serves recorded sandbox prices and
// completes checkouts in-process (lib/reap/recorded.ts), with no network and no API key.
// REAP_MODE=auto (default) calls the sandbox and, when it cannot be reached (revoked key,
// outage, network), serves the recorded prices instead. Quotes/checkouts are routed back by id
// prefix: mock_quote_ / mock_checkout_ belong to the recorded store, everything else to Reap.

import { env } from "@/lib/env";
import type { ReapAdapter } from "@/lib/types";
import { createCheckout, getCheckout, pollCheckout } from "./checkouts";
import { inCooldown, isFallbackWorthyError, lastFallback, recordFallback } from "./fallback";
import { createQuote, getQuote } from "./quotes";
import { recordedReapAdapter } from "./recorded";

export const liveReapAdapter: ReapAdapter = { createQuote, getQuote, createCheckout, getCheckout, pollCheckout };

export const reapMode = (): "live" | "mock" | "auto" => env.REAP_MODE;

// Live first, recorded when Reap can't be reached. Fallbacks are remembered (with a cooldown, so
// a dead sandbox costs one failed call per minute, not one per quote); getQuote / checkouts are
// routed by id prefix because the two adapters keep separate stores.
export function createFallbackReapAdapter(
  live: ReapAdapter,
  recorded: ReapAdapter,
  opts: { now?: () => number; cooldownMs?: number } = {},
): ReapAdapter {
  const now = opts.now ?? Date.now;
  const cooldownMs = opts.cooldownMs ?? 60_000;
  const pick = (id: string) => (id.startsWith("mock_quote_") || id.startsWith("mock_checkout_") ? recorded : live);
  return {
    async createQuote(input) {
      if (inCooldown(now())) return recorded.createQuote(input);
      try {
        return await live.createQuote(input);
      } catch (error) {
        if (!isFallbackWorthyError(error)) throw error;
        console.warn(`[Reap] sandbox unreachable, using recorded prices: ${error instanceof Error ? error.message : error}`);
        recordFallback(now(), cooldownMs, error);
        return recorded.createQuote(input);
      }
    },
    getQuote: (id) => pick(id).getQuote(id),
    createCheckout: (input) => pick(input.quoteId).createCheckout(input),
    getCheckout: (id) => pick(id).getCheckout(id),
    pollCheckout: (id, pollOpts) => pick(id).pollCheckout(id, pollOpts),
  };
}

export const reapAdapter: ReapAdapter =
  reapMode() === "mock"
    ? recordedReapAdapter
    : reapMode() === "live"
      ? liveReapAdapter
      : createFallbackReapAdapter(liveReapAdapter, recordedReapAdapter);

// For GET /api/agent/state: the mode plus the most recent fallback (drives the panel banner).
export function reapStatus(): { mode: "live" | "mock" | "auto"; lastFallback: { at: string; reason: string } | null } {
  return { mode: reapMode(), lastFallback: lastFallback() };
}

export { DEMO_SHIPPING_ADDRESS } from "./quotes";
export { ReapError } from "./client";
