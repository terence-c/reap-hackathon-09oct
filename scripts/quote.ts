import "./load-env";
import type { CatalogItem } from "../lib/types";
import { env } from "../lib/env";
import { createQuote, demoAddress } from "../lib/reap/quotes";

async function main() {
  const item: CatalogItem = {
    sku: "ugreen-wireless-mouse",
    merchantDomain: "ugreen.com.sg",
    name: "UGREEN wireless mouse",
    category: "Electronics",
    unitPrice: { amount: 3299, currency: "SGD" },
    checkoutUrl: "https://ugreen.com.sg/cart/51210551099639:1?attributes[click_id]=agentcart",
    variantId: "51210551099639",
  };
  const quote = await createQuote({ item, quantity: 1, email: env.DEMO_EMAIL, shippingAddress: demoAddress });
  console.log(JSON.stringify({ id: quote.id, finalAmount: quote.finalAmount, expiresAt: quote.expiresAt }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
