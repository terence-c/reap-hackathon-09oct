// GET  [?agentId=] → the registry entry for C's Mandate card (defaults to this app's agent).
// POST { agentId?, status: "ACTIVE" | "REVOKED" } → C's revoke / restore button (or curl).
//   A browser request from another site is refused (403), so a web page can't un-revoke the agent.

import { connection, type NextRequest } from "next/server";
import { z } from "zod";
import { isSameOrigin } from "@/lib/agent/http";
import { env } from "@/lib/env";
import { getAgent, setAgentStatus } from "@/lib/safr/registry";

const BodySchema = z.object({
  agentId: z.string().min(1).optional(),
  status: z.enum(["ACTIVE", "REVOKED"]),
});

export async function GET(request: NextRequest) {
  await connection();
  const agentId = request.nextUrl.searchParams.get("agentId") ?? env.AGENT_ID;
  const agent = getAgent(agentId);
  if (!agent) return Response.json({ error: `Unknown agent: ${agentId}` }, { status: 404 });
  return Response.json({ agent });
}

export async function POST(request: NextRequest) {
  await connection();
  if (request.headers.has("origin") && !isSameOrigin(request))
    return Response.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
  const body = await request.json().catch(() => null);
  if (body === null || typeof body !== "object") return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  const agentId = parsed.data.agentId ?? env.AGENT_ID;
  if (!getAgent(agentId)) return Response.json({ error: `Unknown agent: ${agentId}` }, { status: 404 });
  return Response.json({ agent: setAgentStatus(agentId, parsed.data.status) });
}
