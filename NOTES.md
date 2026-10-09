# Live notes (answers from the Reap table, URLs, gotchas)

## Answers from Reap (Role A fills in at Sync 0)
1. Permalinks as externalCheckout.checkoutUrl in sandbox? →
2. Test card for hosted EXTERNAL enrollment page? →
3. returnUrl rules (HTTPS / allowlist)? → docs: must be HTTPS (enrollment and checkout). Allowlist: ask.
4. Exact sandbox host + Reap-Version value → host: https://sg.sandbox.api.reap.global · Reap-Version: 2025-02-14 (both from Reap's API reference)
5. Are amounts in cents (1079) or dollars (10.79)? → docs only say `number`; check the first real quote for the S$10.79 book.

## Running URLs
- ngrok: 
- Enrollment ID: (in .env.local, do not paste here)

## Gotchas discovered
- Enrollment body is `{ source: "EXTERNAL", owner: { type: "CLIENT_REFERENCE", id, email }, presentation: { type: "REDIRECT", returnUrl } }`, not `{ type, ownerId }`. The hosted card page is `nextAction.url`.
- Quote totals are nested: `amountBreakdown.finalAmount`, `.itemsSubtotal`, `.shipping`, `.tax.amount`. There is no top-level `finalAmount`.
- `POST /agentic/checkouts` returns no `orderId`; read it from `GET /agentic/checkouts/:id` once `status` is `COMPLETED`.
- Shipping option endpoint is `POST /agentic/quotes/:id/shipping`.
- The `items: [{ variantId }]` quote fallback expects Reap's own variant IDs (from `/agentic/products/*`); the Shopify IDs in `catalog.json` may be rejected. Verify before relying on it.
- gpt-6-luna allows tool calls on Chat Completions only with `reasoning_effort: "none"`; `lib/agent/model.ts` sends it automatically.
