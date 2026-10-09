// The agent's only three tools. None of them can spend: getQuote asks Reap for a price and
// proposeCheckout only asks the SAFR gate, which alone decides and, if allowed, calls Reap.

import { tool } from "ai";
import { formatMoney } from "@/lib/safr/disposition";
import { z } from "zod";
import { env } from "@/lib/env";
import catalogJson from "@/lib/catalog.json";
import { DEMO_SHIPPING_ADDRESS, ReapError, reapAdapter } from "@/lib/reap";
import { gate } from "@/lib/safr/gate";
import type { CatalogItem } from "@/lib/types";
import { dispatchTool, type ToolContext } from "./router";

const catalog = catalogJson as unknown as CatalogItem[];

export function createAgentTools(ctx: ToolContext) {
  return {
    listCatalog: tool({
      description:
        "List all catalog items, optionally filtered by category or item price. Catalog visibility does not grant permission to purchase. The gate alone decides permission.",
      inputSchema: z.object({
        category: z.string().optional(),
        maxPriceCents: z.number().int().min(0).optional(),
      }),
      execute: (input) =>
        dispatchTool(ctx, "listCatalog", () => ({
          items: catalog.filter(
            (item) =>
              (!input.category || item.category === input.category) &&
              (input.maxPriceCents === undefined || item.unitPrice.amount <= input.maxPriceCents),
          ),
        })),
    }),
    getQuote: tool({
      description:
        "Get the full price for a catalog item from Reap, including delivery and tax. Amounts are integer cents. Only a Reap quote may be proposed for checkout.",
      inputSchema: z.object({
        sku: z.string(),
        quantity: z.number().int().min(1).max(99),
      }),
      execute: async (input) =>
        dispatchTool(ctx, "getQuote", async () => {
          const item = catalog.find((i) => i.sku === input.sku);
          if (!item) return { error: "We could not find that item. Choose another item from the list." };
          try {
            const quote = await reapAdapter.createQuote({
              item,
              quantity: input.quantity,
              email: env.DEMO_EMAIL,
              shippingAddress: DEMO_SHIPPING_ADDRESS,
            });
            return {
              quote,
              total: formatMoney(quote.finalAmount),
              item: { sku: item.sku, name: item.name, unitPrice: item.unitPrice },
              note: `Amounts are integer cents. The total to pay is ${formatMoney(quote.finalAmount)} (quote.finalAmount). Delivery and tax are already included in it: never add them again. Show this total, then call proposeCheckout if the user wants to buy.`,
            };
          } catch (error) {
            const detail =
              error instanceof ReapError
                ? `${error.status} ${error.code}: ${error.message}`
                : error instanceof Error
                  ? error.message
                  : String(error);
            console.warn(`[agentcart] getQuote failed for ${item.sku}: ${detail}`);
            return {
              error:
                error instanceof ReapError
                  ? "Reap could not price this item right now. Try another item."
                  : "We could not get a price for this item right now. Try another item.",
            };
          }
        }),
    }),
    proposeCheckout: tool({
      description:
        "Ask the gate for permission to purchase a previously obtained Reap quote. The gate decides; it alone can start a Reap checkout. Call at most once per quoteId.",
      inputSchema: z.object({
        quoteId: z.string(),
        reason: z.string().trim().min(1).max(500),
      }),
      execute: async (input) =>
        dispatchTool(ctx, "proposeCheckout", async () => {
          try {
            return await gate.proposeCheckout({
              quoteId: input.quoteId,
              reason: input.reason,
              sessionId: ctx.sessionId,
            });
          } catch (error) {
            console.error(
              `[agentcart] proposeCheckout failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            return { error: "We could not ask for permission right now. Nothing was bought. Please try again." };
          }
        }),
    }),
  };
}
