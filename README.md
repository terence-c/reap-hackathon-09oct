# AgentCart

AI purchasing agent with runtime governance. Built for the Reap × 65labs Agentic Buildathon, Singapore, 9 Oct 2026.

The agent discovers products, gets real merchant quotes through Reap Agentic Payments, and proposes a checkout. A SAFR gateway (agent identity, controls repository, disposition engine, hash-chained audit log) decides Deny / Escalate / Auto-execute / Observe before anything reaches the payment rail.

Demo runbook and problem statement: [docs/DEMO.html](docs/DEMO.html)

## Quick start

```
npm install
cp .env.example .env.local   # fill in REAP_API_KEY and OPENAI_API_KEY
npm run keygen               # paste AGENT_PRIVATE_KEY into .env.local if it prints one
npm run dev:https            # https://localhost:3443
```

Reap only returns people to HTTPS pages, so run the app with `npm run dev:https` (local HTTPS on https://localhost:3443, no tunnel needed). The first run may ask you to trust a local certificate. `APP_BASE_URL` is already set to that address.

Then add the payment card from the app: click "Add card" in the panel and enter the Reap sandbox test card on Reap's page (OTP `456789` if asked). AgentCart never sees the card details. `npm run enroll` does the same from the terminal and prints a `REAP_ENROLLMENT_ID=` line for `.env.local`. `npm run e2e` checks the Reap side on its own (quote, checkout, wait for COMPLETED).

If `better-sqlite3` fails to load, your npm may skip install scripts (`npm config get ignore-scripts` prints `true`); fix it with `cd node_modules/better-sqlite3 && npx prebuild-install`.

Full team setup, the keys to fill in and the step by step checkout run: [SETUP.md](SETUP.md).
