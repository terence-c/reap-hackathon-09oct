import { env } from "@/lib/env";

type ReapRequest = {
  method?: "GET" | "POST";
  body?: unknown;
  idempotencyKey?: string;
  simulateCheckout?: boolean;
};

export class ReapError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ReapError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function reapFetch<T>(path: string, options: ReapRequest = {}): Promise<T> {
  const method = options.method ?? "GET";
  const url = new URL(path.replace(/^\//, ""), `${env.REAP_BASE_URL.replace(/\/$/, "")}/`);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.REAP_API_KEY}`,
    "Reap-Version": env.REAP_API_VERSION,
    "Content-Type": "application/json",
  };
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
  if (options.simulateCheckout && process.env.NODE_ENV !== "production") {
    headers["X-Simulate-Checkout"] = "COMPLETED";
  }

  const requestBody = options.body === undefined ? undefined : JSON.stringify(options.body);
  console.info("[Reap] request", { method, url: url.toString(), body: options.body ?? null });
  const response = await fetch(url, { method, headers, body: requestBody, cache: "no-store" });
  const raw = await response.text();
  let payload: unknown;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = raw;
  }
  console.info("[Reap] response", { method, url: url.toString(), status: response.status, body: payload });

  if (!response.ok) {
    const error = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    const nested = error.error && typeof error.error === "object"
      ? (error.error as Record<string, unknown>)
      : error;
    throw new ReapError(
      response.status,
      String(nested.code ?? "REAP_REQUEST_FAILED"),
      String(nested.message ?? response.statusText ?? "Reap request failed"),
      payload,
    );
  }
  return payload as T;
}
