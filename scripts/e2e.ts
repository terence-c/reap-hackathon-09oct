import "./load-env";
import type { CatalogItem } from "../lib/types";
import { env } from "../lib/env";
import { createCheckout, pollCheckout } from "../lib/reap/checkouts";
import catalog from "../lib/catalog.json";
import { createQuote, DEMO_SHIPPING_ADDRESS } from "../lib/reap/quotes";
import { reapFetch } from "../lib/reap/client";

type Enrollment = { id: string; status: string };

async function main() {
  const enrollmentId = env.REAP_ENROLLMENT_ID;
  if (!enrollmentId) throw new Error("Set REAP_ENROLLMENT_ID after completing npm run enroll");
  const enrollment = await reapFetch<Enrollment>(`/agentic/enrollments/${encodeURIComponent(enrollmentId)}`);
  if (enrollment.status !== "ACTIVE") throw new Error(`Enrollment is ${enrollment.status}; expected ACTIVE`);

  const sku = process.argv[2] ?? "popular-ghost-stories-12";
  const item = (catalog as CatalogItem[]).find((i) => i.sku === sku);
  if (!item) throw new Error(`No catalog item ${sku}`);
  const quote = await createQuote({ item, quantity: 1, email: env.DEMO_EMAIL, shippingAddress: DEMO_SHIPPING_ADDRESS });
  console.log("Quote:", JSON.stringify({ id: quote.id, finalAmount: quote.finalAmount }));

  const checkout = await createCheckout({
    quoteId: quote.id,
    enrollmentId,
    returnUrl: `${env.APP_BASE_URL}/orders/done`,
    idempotencyKey: `e2e-${crypto.randomUUID()}`,
  });
  console.log("Checkout:", checkout.id, checkout.status);
  if (checkout.nextAction?.url) console.log("Hosted approval URL:", checkout.nextAction.url);
  const completed = await pollCheckout(checkout.id);
  if (completed.status !== "COMPLETED" || !completed.orderId) {
    throw new Error(`Checkout ended as ${completed.status}; no completed order ID was returned`);
  }
  console.log(JSON.stringify({ status: completed.status, orderId: completed.orderId, finalAmount: completed.finalAmount }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
