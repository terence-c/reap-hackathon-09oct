// GET  → the mandate plus what's left of its budget, for C's Mandate card.
// POST <Mandate without version> → C's MandateEditor; validates, bumps version, returns the saved mandate.
//   400 when a field is invalid, autoThreshold > totalBudget, or validFrom is not before validTo
//   (the same rules as PATCH /api/agent/state). No Origin header (curl) is allowed; a browser
//   request from another site is refused, so a web page can't rewrite the user's spending limits.

import { connection, type NextRequest } from "next/server";
import { isSameOrigin } from "@/lib/agent/http";
import { committed, loadMandate, MandateFieldsSchema, saveMandate, withMandateRules } from "@/lib/safr/controls";
import { gate } from "@/lib/safr/gate";

const BodySchema = withMandateRules(MandateFieldsSchema.omit({ version: true }));

function snapshot() {
  gate.expireStaleApprovals(); // a timed-out escalation must not keep holding budget in the figures below
  const mandate = loadMandate();
  const { reserved, settled } = committed(mandate.id);
  return { mandate, reserved, settled, remaining: mandate.totalBudget - reserved - settled };
}

export async function GET() {
  await connection();
  return Response.json(snapshot());
}

export async function POST(request: NextRequest) {
  await connection();
  if (request.headers.has("origin") && !isSameOrigin(request))
    return Response.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json(
      { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
      { status: 400 },
    );
  if (parsed.data.id !== loadMandate().id) return Response.json({ error: "Unknown mandate id" }, { status: 404 });
  saveMandate(parsed.data);
  return Response.json(snapshot());
}
