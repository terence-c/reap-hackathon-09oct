import { tool } from "ai";
import { z } from "zod";
import { env } from "@/lib/env";
import catalogJson from "@/lib/catalog.json";
import type { CatalogItem, ShippingAddress } from "@/lib/types";
import { dispatchTool, type ToolContext } from "./router";
import { createStubQuote, stubGate } from "./stubs";

const catalog = catalogJson as unknown as CatalogItem[];

const DEMO_SHIPPING_ADDRESS: ShippingAddress = {
  firstName: "Demo",
  lastName: "User",
  phone: "+65 0000 0000",
  addressLine1: "1 Demo Street",
  city: "Singapore",
  postalCode: "000000",
  country: "SG",
};

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
        dispatchTool(ctx, "listCatalog", input, () => ({
          items: catalog.filter(
            (item) =>
              (!input.category || item.category === input.category) &&
              (input.maxPriceCents === undefined ||
                item.unitPrice.amount <= input.maxPriceCents),
          ),
        })),
    }),
    getQuote: tool({
      description:
        "Get the full server price for a catalog item, including delivery and tax. Only a server quote may be proposed for checkout.",
      inputSchema: z.object({
        sku: z.string(),
        quantity: z.number().int().min(1).max(99),
      }),
      execute: async (input) =>
        dispatchTool(ctx, "getQuote", input, async () => {
          const item = catalog.find((i) => i.sku === input.sku);
          if (!item)
            return { error: "We could not find that item. Choose another item from the list." };
          const quote = await createStubQuote(ctx.sessionId, {
            item,
            quantity: input.quantity,
            email: env.DEMO_EMAIL,
            shippingAddress: DEMO_SHIPPING_ADDRESS,
          });
          return {
            quote,
            item: { sku: item.sku, name: item.name, unitPrice: item.unitPrice },
            note: "Show the full quoted price, including delivery and tax, in its original currency before asking for permission.",
          };
        }),
    }),
    proposeCheckout: tool({
      description:
        "Ask the gate for permission to purchase a previously obtained server quote. Call at most once per quoteId.",
      inputSchema: z.object({
        quoteId: z.string(),
        reason: z.string().trim().min(1).max(500),
      }),
      execute: async (input) =>
        dispatchTool(ctx, "proposeCheckout", input, async () => {
          try {
            return await stubGate.proposeCheckout({
              quoteId: input.quoteId,
              reason: input.reason,
              sessionId: ctx.sessionId,
            });
          } catch (error) {
            return {
              error: error instanceof Error ? error.message : "We could not finish this step. Please try again.",
            };
          }
        }),
    }),
  };
}
