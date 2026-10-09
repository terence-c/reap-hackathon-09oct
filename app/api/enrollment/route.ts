// GET  → the current card enrollment ({ enrollment: {id,status,url?,updatedAt} | null }); a pending one
//        is refreshed from Reap so the page can watch it turn ACTIVE.
// POST → starts a new EXTERNAL enrollment and returns Reap's hosted card-entry url. Card details are
//        typed on Reap's page only; AgentCart never sees or stores them.

import { connection, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { isSameOrigin } from "@/lib/agent/http";
import { createEnrollment, currentEnrollment, refreshPendingEnrollments } from "@/lib/reap/enrollments";
import { loadMandate } from "@/lib/safr/controls";

const noStore = { "cache-control": "no-store" };

export async function GET() {
  await connection();
  if (currentEnrollment()?.status !== "ACTIVE") await refreshPendingEnrollments();
  return Response.json({ enrollment: currentEnrollment() }, { headers: noStore });
}

export async function POST(request: NextRequest) {
  await connection();
  if (!isSameOrigin(request)) return Response.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
  try {
    const enrollment = await createEnrollment({
      ownerId: loadMandate().principalId,
      email: env.DEMO_EMAIL,
      returnUrl: `${env.APP_BASE_URL}/orders/enrollment-done`,
    });
    if (!enrollment.url) return Response.json({ error: "Reap did not return a card page." }, { status: 502 });
    return Response.json({ enrollment }, { headers: noStore });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not start adding a card.";
    console.error(`[enrollment] create failed: ${message}`);
    return Response.json({ error: message }, { status: 502 });
  }
}
