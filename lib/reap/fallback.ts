// Shared by the auto-mode adapter (lib/reap/index.ts) and card enrollment: what counts as
// "Reap can't be reached" and where the last fallback is remembered. Kept on globalThis because
// Next bundles each route separately (see the note in lib/reap/recorded.ts).

import { ReapError } from "./client";

// A failure that justifies serving the recorded sandbox prices instead: auth/key problems,
// rate limiting, server errors, timeouts, anything fetch threw, and a missing/blank
// REAP_API_KEY (the env parse error). Everything else (422 validation, CHECKOUT_URL_INVALID)
// is a real answer from Reap and is rethrown unchanged.
export function isFallbackWorthyError(error: unknown): boolean {
  if (error instanceof ReapError) {
    return error.status === 401 || error.status === 403 || error.status === 408 || error.status === 429 || error.status >= 500;
  }
  if (error instanceof Error && error.message.startsWith("Missing or invalid env vars")) return true;
  // fetch failures (network, DNS, TLS, timeout) surface as TypeError; anything else thrown by
  // the transport counts too, but adapter-level errors (e.g. zod on a real response) do not.
  return error instanceof TypeError;
}

type FallbackState = {
  until: number;
  last: { at: number; reason: string } | null;
};

const g = globalThis as unknown as { __agentcartReapFallback?: FallbackState };

export function fallbackState(): FallbackState {
  return (g.__agentcartReapFallback ??= { until: 0, last: null });
}

// Test helper: forget cooldown and the last recorded fallback.
export function resetReapFallback() {
  g.__agentcartReapFallback = undefined;
}

export function inCooldown(now: number): boolean {
  return now < fallbackState().until;
}

export function recordFallback(now: number, cooldownMs: number, error: unknown) {
  const state = fallbackState();
  state.until = now + cooldownMs;
  state.last = { at: now, reason: error instanceof Error ? error.message : String(error) };
}

export function lastFallback(): { at: string; reason: string } | null {
  const last = fallbackState().last;
  return last ? { at: new Date(last.at).toISOString(), reason: last.reason } : null;
}
