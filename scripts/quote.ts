import "./load-env";
import type { CatalogItem } from "../lib/types";
import { env } from "../lib/env";
import catalog from "../lib/catalog.json";
import { createQuote, DEMO_SHIPPING_ADDRESS } from "../lib/reap/quotes";

async function main() {
  const sku = process.argv[2] ?? "popular-ghost-stories-12";
  const item = (catalog as CatalogItem[]).find((i) => i.sku === sku);
  if (!item) throw new Error(`No catalog item ${sku}`);
  const quote = await createQuote({ item, quantity: 1, email: env.DEMO_EMAIL, shippingAddress: DEMO_SHIPPING_ADDRESS });
  console.log(JSON.stringify({ id: quote.id, finalAmount: quote.finalAmount, expiresAt: quote.expiresAt }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
