// Lane A's ReapAdapter: the only object in the app that talks to Reap. B's gate gets it through
// lib/safr/reap-adapter.ts; nothing hands it to the LLM.
//
// REAP_MODE=live (default) calls the Reap sandbox. REAP_MODE=mock serves recorded sandbox prices
// and completes checkouts in-process (lib/reap/recorded.ts), with no network and no API key.

import { env } from "@/lib/env";
import type { ReapAdapter } from "@/lib/types";
import { createCheckout, getCheckout, pollCheckout } from "./checkouts";
import { createQuote, getQuote } from "./quotes";
import { recordedReapAdapter } from "./recorded";

export const liveReapAdapter: ReapAdapter = { createQuote, getQuote, createCheckout, getCheckout, pollCheckout };

export const reapMode = (): "live" | "mock" => env.REAP_MODE;

export const reapAdapter: ReapAdapter = reapMode() === "mock" ? recordedReapAdapter : liveReapAdapter;

export { DEMO_SHIPPING_ADDRESS } from "./quotes";
export { ReapError } from "./client";
