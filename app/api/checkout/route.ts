// GET /api/checkout?envelopeHash=<sha256>  or  ?checkoutId=<Reap id>
//   → { checkoutId, status, orderId?, finalAmount? (cents), envelopeHash? }
// Read-only status for the /orders/done page. Every call re-reads GET /agentic/checkouts/:id from
// Reap and records the outcome with the gate: COMPLETED settles the budget hold, FAILED / EXPIRED
// release it (both idempotent, so polling is safe).
//
// There is deliberately no POST. Checkouts are only created by the SAFR gate, in-process
// (lib/safr/gate.ts), so no public route can skip the gate.

import { connection, type NextRequest } from "next/server";
import { reapAdapter, ReapError } from "@/lib/reap";
import { checkoutIdForEnvelope, recordCheckoutOutcome, simulatedCheckout } from "@/lib/safr/gate";

const ENVELOPE_HASH = /^[0-9a-f]{64}$/;
const CHECKOUT_ID = /^[A-Za-z0-9_-]{1,128}$/;

const NO_STORE = { "cache-control": "no-store" };

function reply(body: unknown, status = 200) {
  return Response.json(body, { status, headers: NO_STORE });
}

export async function GET(request: NextRequest) {
  await connection();
  const params = request.nextUrl.searchParams;
  const envelopeHash = params.get("envelopeHash");
  const requestedCheckoutId = params.get("checkoutId");

  let checkoutId: string;
  if (envelopeHash !== null) {
    if (!ENVELOPE_HASH.test(envelopeHash)) return reply({ error: "envelopeHash must be a sha256 hex hash" }, 400);
    const known = checkoutIdForEnvelope(envelopeHash);
    if (!known) return reply({ error: "No checkout is known for that envelope." }, 404);
    checkoutId = known;
  } else if (requestedCheckoutId !== null) {
    if (!CHECKOUT_ID.test(requestedCheckoutId)) return reply({ error: "checkoutId is not valid" }, 400);
    checkoutId = requestedCheckoutId;
  } else {
    return reply({ error: "Pass envelopeHash or checkoutId" }, 400);
  }

  let checkout = simulatedCheckout(checkoutId);
  const simulated = checkout !== null;
  try {
    checkout ??= await reapAdapter.getCheckout(checkoutId);
  } catch (err) {
    const detail = err instanceof ReapError ? err.code : err instanceof Error ? err.message : String(err);
    console.error(`[checkout] Reap status check failed for ${checkoutId}: ${detail}`);
    return reply({ error: `Could not read the checkout from Reap (${detail}).` }, 502);
  }

  const outcome = recordCheckoutOutcome(checkout.id, checkout.status);
  const hash = envelopeHash ?? outcome?.envelopeHash;
  return reply({
    checkoutId: checkout.id,
    status: checkout.status,
    ...(checkout.orderId ? { orderId: checkout.orderId } : {}),
    ...(checkout.finalAmount ? { finalAmount: checkout.finalAmount } : {}),
    ...(hash ? { envelopeHash: hash } : {}),
    ...(simulated ? { simulated: true } : {}),
  });
}
