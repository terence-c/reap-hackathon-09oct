// GET  → pending escalations for C's ApprovalCard.
// POST { envelopeHash, action: "APPROVE" | "DECLINE", reviewer } → ProposeCheckoutResult.
//   The result's envelopeHash can differ from the one posted: if the quote or mandate changed while
//   waiting, the gate rebuilds the envelope and the checkout belongs to the new hash.
//   A browser request from another site is refused (403), so a web page can't approve a purchase.

import { connection, type NextRequest } from "next/server";
import { z } from "zod";
import { isSameOrigin } from "@/lib/agent/http";
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

export async function POST(request: NextRequest) {
  await connection();
  if (request.headers.has("origin") && !isSameOrigin(request))
    return Response.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
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
