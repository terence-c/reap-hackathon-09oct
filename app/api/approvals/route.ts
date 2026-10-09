// GET  → pending escalations for C's ApprovalCard.
// POST { envelopeHash, action: "APPROVE" | "DECLINE", reviewer } → ProposeCheckoutResult.

import { connection } from "next/server";
import { z } from "zod";
import { gate, GateError } from "@/lib/safr/gate";

const BodySchema = z.object({
  envelopeHash: z.string().regex(/^[0-9a-f]{64}$/, "must be a sha256 hex hash"),
  action: z.enum(["APPROVE", "DECLINE"]),
  reviewer: z.string().trim().min(1).max(100),
});

export async function GET() {
  await connection();
  return Response.json({ approvals: gate.listPendingApprovals() });
}

export async function POST(request: Request) {
  await connection();
  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  const { envelopeHash, action, reviewer } = parsed.data;
  try {
    const result = action === "APPROVE" ? await gate.approve(envelopeHash, reviewer) : await gate.decline(envelopeHash, reviewer);
    return Response.json(result);
  } catch (err) {
    if (err instanceof GateError) return Response.json({ error: err.message, code: err.code }, { status: err.status });
    throw err;
  }
}
