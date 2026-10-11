// Dev-only: reset the demo inside the running server (npm run reset-demo calls this when the
// server is up, so the reset always reaches the connection the app is using). 404 in production.

import { connection, NextResponse, type NextRequest } from "next/server";
import { isSameOrigin, jsonError } from "@/lib/agent/http";
import { resetDemo } from "@/lib/safr/reset";

export async function POST(request: NextRequest) {
  await connection();
  if (process.env.NODE_ENV === "production") return jsonError(404, "Not found.");
  if (!isSameOrigin(request)) return jsonError(403, "Cross-origin requests are not allowed.");
  return NextResponse.json(resetDemo(), { headers: { "cache-control": "no-store" } });
}
