import type { Checkout, CheckoutStatus, Currency } from "@/lib/types";
import { env } from "@/lib/env";
import { reapFetch } from "./client";

type CheckoutResponse = {
  id: string;
  status: CheckoutStatus;
  orderId?: string | null;
  finalAmount?: { amount: number; currency: Currency } | null;
  amount?: { amount: number; currency: Currency };
  nextAction?: { url?: string; expiresAt?: string } | null;
};

function mapCheckout(response: CheckoutResponse): Checkout {
  return {
    id: response.id,
    status: response.status,
    ...(response.orderId ? { orderId: response.orderId } : {}),
    ...(response.finalAmount ?? response.amount
      ? { finalAmount: response.finalAmount ?? response.amount! }
      : {}),
    ...(response.nextAction?.url
      ? { nextAction: { url: response.nextAction.url, expiresAt: response.nextAction.expiresAt ?? "" } }
      : {}),
  };
}

export async function createCheckout(input: {
  quoteId: string;
  enrollmentId: string;
  returnUrl: string;
  idempotencyKey: string;
}): Promise<Checkout> {
  const returnUrl = new URL(input.returnUrl);
  if (returnUrl.protocol !== "https:" && process.env.NODE_ENV === "production") {
    throw new Error("Reap hosted checkout returnUrl must use HTTPS in production");
  }
  if (returnUrl.protocol !== "https:" && !input.returnUrl.startsWith("http://localhost")) {
    throw new Error("Checkout returnUrl must use HTTPS (or localhost during local development)");
  }
  const response = await reapFetch<CheckoutResponse>("/agentic/checkouts", {
    method: "POST",
    body: {
      quoteId: input.quoteId,
      enrollmentId: input.enrollmentId,
      presentation: { type: "REDIRECT", returnUrl: input.returnUrl },
    },
    idempotencyKey: input.idempotencyKey,
    simulateCheckout: env.REAP_BASE_URL.includes("sandbox"),
  });
  return mapCheckout(response);
}

export async function getCheckout(id: string): Promise<Checkout> {
  const response = await reapFetch<CheckoutResponse>(`/agentic/checkouts/${encodeURIComponent(id)}`);
  return mapCheckout(response);
}

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
  throw new Error(`Checkout ${id} did not reach a terminal status within ${timeoutMs}ms (last: ${current?.status ?? "unknown"})`);
}
