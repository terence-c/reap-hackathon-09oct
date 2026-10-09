// GET  → the mandate plus what's left of its budget, for C's Mandate card.
// POST <Mandate without version> → C's MandateEditor; validates, bumps version, returns the saved mandate.

import { connection } from "next/server";
import { committed, loadMandate, MandateSchema, saveMandate } from "@/lib/safr/controls";

const BodySchema = MandateSchema.omit({ version: true });

function snapshot() {
  const mandate = loadMandate();
  const { reserved, settled } = committed(mandate.id);
  return { mandate, reserved, settled, remaining: mandate.totalBudget - reserved - settled };
}

export async function GET() {
  await connection();
  return Response.json(snapshot());
}

export async function POST(request: Request) {
  await connection();
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
