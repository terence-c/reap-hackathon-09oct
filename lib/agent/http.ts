import { randomUUID } from "crypto";
import { NextResponse, type NextRequest } from "next/server";

export const SESSION_COOKIE = "agentcart_session";
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    // Compare against the Host the browser actually used (localhost vs 127.0.0.1 both work).
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    return !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}

export type BodyRead =
  | { ok: true; value: unknown }
  | { ok: false; reason: "too-large" | "malformed" | "unreadable" };

export async function readJsonBody(request: NextRequest, maxBytes: number): Promise<BodyRead> {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) {
    return { ok: false, reason: "too-large" };
  }
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, reason: "unreadable" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, reason: "too-large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  try {
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, value: JSON.parse(new TextDecoder().decode(merged)) };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

export function sessionIdFrom(request: NextRequest): { id: string; isNew: boolean } {
  const existing = request.cookies.get(SESSION_COOKIE)?.value;
  if (existing && SESSION_ID_PATTERN.test(existing)) return { id: existing, isNew: false };
  return { id: randomUUID(), isNew: true };
}

export function setSessionCookie(response: NextResponse | Response, id: string): void {
  const secure = process.env.NODE_ENV === "production";
  response.headers.append(
    "set-cookie",
    `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure ? "; Secure" : ""}`,
  );
}

export function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
}
