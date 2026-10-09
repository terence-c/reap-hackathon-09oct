# Live notes (answers from the Reap table, URLs, gotchas)

## Answers from Reap (Role A fills in at Sync 0)
1. Permalinks as externalCheckout.checkoutUrl in sandbox? → Reap docs accept an application-constructed checkout URL in `externalCheckout`; domains must be allowlisted for this integration. Confirm UGREEN and the other demo domains with Reap. `items` uses Reap discovery variant IDs; external merchant-sheet variant IDs may not be valid there.
2. Test card for hosted EXTERNAL enrollment page? → Reap docs list Agentic sandbox cards (CVC / expiry also documented): 4622 9431 2313 7797 / 640 / 12/27; 4622 9431 2313 7805 / 304 / 12/27; 4622 9431 2313 7847 / 698 / 12/27. OTP if prompted: 456789. Confirm with Reap which card to use at the event.
3. returnUrl rules (HTTPS / allowlist)? → Reap setup docs require HTTPS for hosted enrollment and hosted approval returns. Ask Reap whether the URL must also be allowlisted.
4. Exact sandbox host + Reap-Version value → host: https://sg.sandbox.api.reap.global · Reap API reference specifies `2025-02-14`. A read-only GET using the configured `.env.local` values returned HTTP 400 `AGENTIC_REQUEST_REJECTED`; confirm the version/credentials and enrollment ID with Reap.
5. Are amounts in cents (1079) or dollars (10.79)? → **Decision: integer cents end to end.** Treat Reap amounts as cents, no conversion. If a real quote shows otherwise, fix it in the adapter.

## Running URLs
- ngrok: 
- Enrollment ID: (in .env.local, do not paste here)

## Gotchas discovered
- Hosted Reap flows cannot be completed until `APP_BASE_URL` is an HTTPS URL (for example, the active ngrok URL) and a human enters the sandbox card.
- Configured enrollment verification returned HTTP 400 `AGENTIC_REQUEST_REJECTED`; no response body or credentials were recorded.
- Enrollment body is `{ source: "EXTERNAL", owner: { type: "CLIENT_REFERENCE", id, email }, presentation: { type: "REDIRECT", returnUrl } }`, not `{ type, ownerId }`. The hosted card page is `nextAction.url`.
- Quote totals are nested: `amountBreakdown.finalAmount`, `.itemsSubtotal`, `.shipping`, `.tax.amount`. There is no top-level `finalAmount`.
- `POST /agentic/checkouts` returns no `orderId`; read it from `GET /agentic/checkouts/:id` once `status` is `COMPLETED`.
- Shipping option endpoint is `POST /agentic/quotes/:id/shipping`.
- The `items: [{ variantId }]` quote fallback expects Reap's own variant IDs (from `/agentic/products/*`); the Shopify IDs in `catalog.json` may be rejected. **Decision: A builds the adapter first; the team fixes whatever errors show up after.**
- gpt-6-luna allows tool calls on Chat Completions only with `reasoning_effort: "none"`; `lib/agent/model.ts` sends it automatically.
