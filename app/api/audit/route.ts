// GET → the audit timeline, the chain check for C's badge, and recent TOOL_DENIED events.

import { connection } from "next/server";
import { list, verifyChain } from "@/lib/safr/audit";
import { listToolDenials } from "@/lib/safr/registry";

export async function GET() {
  await connection();
  return Response.json({ entries: list(), chain: verifyChain(), toolDenials: listToolDenials() });
}
