# Live notes (answers from the Reap table, URLs, gotchas)

## Answers from Reap (verified against the sandbox)
1. Permalinks as externalCheckout.checkoutUrl in sandbox? → Quotes for the book (popular.com.sg) and the laptop stand (zmdesktop.com) work through the adapter. It sends the merchant-sheet cart permalink from `catalog.json` first and falls back to `items: [{ variantId }]` only if Reap answers `CHECKOUT_URL_INVALID` (that path expects Reap's own discovery variant IDs).
2. Test card for hosted EXTERNAL enrollment page? → Reap docs list Agentic sandbox cards (CVC / expiry also documented): 4622 9431 2313 7797 / 640 / 12/27; 4622 9431 2313 7805 / 304 / 12/27; 4622 9431 2313 7847 / 698 / 12/27. OTP if prompted: 456789.
3. returnUrl rules → Must be HTTPS. `http://` is rejected; `https://localhost:3443` is accepted, so local dev runs `npm run dev:https` and sets `APP_BASE_URL=https://localhost:3443`. No tunnel needed.
4. Sandbox host + Reap-Version → `https://sg.sandbox.api.reap.global`, `Reap-Version: 2025-02-14`. `GET /agentic/enrollments` with the current key returns 200 (the earlier 400 `AGENTIC_REQUEST_REJECTED` no longer happens).
5. Are amounts in cents or dollars? → **Dollars** (decimal major units, e.g. `{ "amount": 10.79, "currency": "SGD" }`). `lib/reap/money.ts` `toCents` converts every Reap amount once, at the adapter boundary; everything else in AgentCart stays integer cents. This replaces the earlier "treat as cents" decision.

## Running URLs
- App (local HTTPS): https://localhost:3443 via `npm run dev:https`
- Reap return pages: `/orders/done?envelopeHash=<hash>` (checkout, polls `GET /api/checkout`) and `/orders/enrollment-done` (card, polls `GET /api/enrollment`)
- Enrollment ID: (in .env.local, do not paste here)

## Gotchas discovered
- Enrollment body is `{ source: "EXTERNAL", owner: { type: "CLIENT_REFERENCE", id, email }, presentation: { type: "REDIRECT", returnUrl } }`, not `{ type, ownerId }`. The hosted card page is `nextAction.url`.
- Emails on reserved test domains (`.test`) are rejected; use `DEMO_EMAIL=demo@example.com`.
- Quote totals are nested: `amountBreakdown.finalAmount`, `.itemsSubtotal`, `.shipping`, `.tax` (tax arrives either as `{ amount: Money }` or as plain Money; the adapter accepts both). There is no top-level `finalAmount`.
- Quote responses (POST and GET) do not echo the merchant. `lib/reap/quote-store.ts` records merchant, SKU and quantity when we create the quote, so `getQuote` can rebuild a full `Quote` for the gate.
- Shipping option endpoint is `POST /agentic/quotes/:id/shipping-option` (`/shipping` is a 404).
- `POST /agentic/checkouts` returns no `orderId`; read it from `GET /agentic/checkouts/:id` once `status` is `COMPLETED`.
- In sandbox the adapter sends `X-Simulate-Checkout: COMPLETED` (`REAP_SIMULATE_CHECKOUT`, default true), so checkouts complete without the hosted approval step. Never sent outside sandbox.
- brewlander.com quotes currently fail with 503 `AGENTIC_SERVICE_UNAVAILABLE` (Reap side), so the beer step cannot get a live quote.
- The laptop stand (zmdesktop.com) quotes in SGD (S$76.00), even though the catalog lists it at US$58.00. The currency DENY in the demo therefore comes from the catalog's listed currency, which the gate checks alongside the quote's currency.
- Phone must match `^\+[1-9]\d{6,14}$` and merchants reject obviously fake numbers; `DEMO_SHIPPING_ADDRESS` uses a real-format SG mobile and postcode.
- gpt-6-luna allows tool calls on Chat Completions only with `reasoning_effort: "none"`; `lib/agent/model.ts` sends it automatically.
