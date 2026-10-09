// Lane A's ReapAdapter: the only object in the app that talks to Reap. B's gate gets it through
// lib/safr/reap-adapter.ts; nothing hands it to the LLM.

import type { ReapAdapter } from "@/lib/types";
import { createCheckout, getCheckout, pollCheckout } from "./checkouts";
import { createQuote, getQuote } from "./quotes";

export const reapAdapter: ReapAdapter = { createQuote, getQuote, createCheckout, getCheckout, pollCheckout };

export { DEMO_SHIPPING_ADDRESS } from "./quotes";
export { ReapError } from "./client";
