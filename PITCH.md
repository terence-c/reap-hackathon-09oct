# AgentCart: 90-second pitch

Click the quick-prompt tiles in order while you talk. Approve the luggage tag in the Permission card.

**1. Delegation (0:00)**
"AI agents can now shop for us. The hard part is not the shopping. It is trust. So AgentCart starts with delegation: I set my spending limits. S$150 in total, anything above S$80 needs my approval, Singapore dollars only, office and book supplies only."

**2. Autonomy (0:15)**
"Then the agent shops on its own. I ask for a book. It browses the catalog and gets a real quote from Reap, with delivery and tax included."

**3. Execution (0:25)**
"True Singapore Ghost Stories, S$10.79. It is inside my limits, so it goes straight through Reap's checkout. And we only say the order is confirmed when Reap reports it completed."

**4. Control (0:38)**
"Now an S$85 luggage tag. That is above my S$80 line, so the agent cannot finish it alone. It lands here, in front of me. I approve, and only then does it go to Reap."

**5. Protection (0:50)**
"An S$699 table: over my budget, denied. A laptop stand priced in US dollars: wrong currency, denied. A six-pack of beer: wrong category, denied. In all three, Reap's checkout is never called. The agent has no payment tool at all. It can only ask our gate."

**6. Accountability (1:05)**
"Every request becomes a purchase record, signed with the agent's own key, showing which rules fired, and written to a hash-chained log before any money moves. If I pause the agent, its next purchase is refused at the identity check. And if anyone edits a saved record afterwards" (click Tamper with a record) "the badge turns red."

**Close (1:22)**
"Every agent can decide; ours can't spend until its authority is verified, its limits checked, and the decision logged."

If Reap still cannot price the beer on the day (brewlander.com has been returning "service unavailable"), say: "Reap can't price this merchant right now. If it could, the gate would deny it on category before any checkout." The category rule is covered by the test suite.

## Submission

**Problem.** AI agents are being given payment access, but an agent holding a card can spend anything, anywhere, and afterwards nobody can prove what it was allowed to do. The MAS white paper on Safeguards for Agentic Finance at Runtime (SAFR) asks for agent identity, controls, a disposition decision and an audit trail at the moment of spending, not after the fact.

**What we built.** AgentCart is a purchasing agent whose only route to money is a SAFR gate. The agent has three tools (browse the catalog, get a quote, propose a purchase), and none of them can pay. For every proposal the gate rebuilds the request from server data (Reap's quote, our catalog and the user's spending limits), signs it, checks the agent's identity first, then checks budget, approval threshold, currency, category and repeat purchases. It writes the decision to a hash-chained log before calling Reap. There are four outcomes: allowed, needs human approval, allowed but flagged as a repeat, and denied.

**How it uses Reap's Agentic module.**
- EXTERNAL enrollment: the user adds a card on Reap's hosted page, from the app's Add card button or `npm run enroll`. AgentCart never sees card details.
- Quotes from merchant permalinks: `POST /agentic/quotes` with `externalCheckout.checkoutUrl` from Reap's merchant sheet. At decision time the gate re-reads the quote with `GET /agentic/quotes/:id` and never trusts numbers from the model.
- Hosted or simulated checkout: `POST /agentic/checkouts` is only ever called from inside the gate, with the purchase record's hash as the idempotency key. In sandbox we send `X-Simulate-Checkout`; otherwise the user confirms on Reap's hosted page.
- Status polling: `GET /agentic/checkouts/:id` until COMPLETED, FAILED or EXPIRED. Only COMPLETED shows "Order confirmed" and turns the budget hold into spent money; FAILED or EXPIRED releases it.

**Track.** Most Worthwhile Problem.

**Why identity is a signature, not a string.** An agent ID is just text anyone can type. Our gate only acts on purchase records signed with the agent's private key and checked against the public key in the registry, so a forged or altered request fails before any money moves, and revoking the agent stops it instantly.
