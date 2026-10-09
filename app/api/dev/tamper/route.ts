// Dev-only demo: edit the amount inside one stored activity record, the way an insider editing the
// SQLite file would, so the panel's "Records match" badge turns red. 404 in production.

import { connection, NextResponse, type NextRequest } from "next/server";
import { isSameOrigin, jsonError } from "@/lib/agent/http";
import { tamperForDemo } from "@/lib/safr/audit";

export async function POST(request: NextRequest) {
  await connection();
  if (process.env.NODE_ENV === "production") return jsonError(404, "Not found.");
  if (!isSameOrigin(request)) return jsonError(403, "Cross-origin requests are not allowed.");
  try {
    return NextResponse.json({ seq: tamperForDemo() }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.warn(`[agentcart] tamper failed: ${error instanceof Error ? error.message : error}`);
    return jsonError(409, "There are no records to change yet.");
  }
}
