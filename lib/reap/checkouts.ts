import { z } from "zod";
import type { Checkout } from "@/lib/types";
import { env } from "@/lib/env";
import { reapFetch } from "./client";
import { ReapMoneySchema } from "./money";

const CheckoutResponseSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["REQUIRES_ACTION", "PROCESSING", "COMPLETED", "FAILED", "EXPIRED"]),
  orderId: z.string().nullish(),
  finalAmount: ReapMoneySchema.nullish(),
  amount: ReapMoneySchema.nullish(),
  nextAction: z.object({ url: z.string().optional(), expiresAt: z.string().optional() }).nullish(),
});

function toCheckout(raw: unknown): Checkout {
  const parsed = CheckoutResponseSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Unexpected checkout response from Reap: ${parsed.error.issues[0]?.message}`);
  const c = parsed.data;
  const finalAmount = c.finalAmount ?? c.amount;
  return {
    id: c.id,
    status: c.status,
    ...(c.orderId ? { orderId: c.orderId } : {}),
    ...(finalAmount ? { finalAmount } : {}),
    ...(c.nextAction?.url ? { nextAction: { url: c.nextAction.url, expiresAt: c.nextAction.expiresAt ?? "" } } : {}),
  };
}

export async function createCheckout(input: {
  quoteId: string;
  enrollmentId: string;
  returnUrl: string;
  idempotencyKey: string;
}): Promise<Checkout> {
  // Reap rejects non-HTTPS return URLs (422). Locally, run `npm run dev:https` (https://localhost:3443).
  if (new URL(input.returnUrl).protocol !== "https:") {
    throw new Error(`Checkout returnUrl must be HTTPS (got ${input.returnUrl}); set APP_BASE_URL and use npm run dev:https`);
  }
  const raw = await reapFetch("/agentic/checkouts", {
    method: "POST",
    body: {
      quoteId: input.quoteId,
      enrollmentId: input.enrollmentId,
      presentation: { type: "REDIRECT", returnUrl: input.returnUrl },
    },
    idempotencyKey: input.idempotencyKey,
    simulateCheckout: env.REAP_SIMULATE_CHECKOUT && env.REAP_BASE_URL.includes("sandbox"),
  });
  return toCheckout(raw);
}

export async function getCheckout(id: string): Promise<Checkout> {
  return toCheckout(await reapFetch(`/agentic/checkouts/${encodeURIComponent(id)}`));
}

// Resolves only on a final status. REQUIRES_ACTION / PROCESSING keep polling.
export async function pollCheckout(
  id: string,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<Checkout> {
  const intervalMs = opts.intervalMs ?? 2_000;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  let current: Checkout | undefined;
  while (Date.now() <= deadline) {
    current = await getCheckout(id);
    if (current.status === "COMPLETED" || current.status === "FAILED" || current.status === "EXPIRED") {
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
  }
  throw new Error(`Checkout ${id} did not reach a final status within ${timeoutMs}ms (last: ${current?.status ?? "unknown"})`);
}
