# AgentCart Team Setup

Clone the repo, fill in `.env.local`, and run the app over local HTTPS. The keys you need and a step-by-step real checkout are below.

## Setup

Each person does this once on their own laptop, in about 10 minutes.

1. Install Node 20.9 or newer (tested on Node 24) and git. Ask the repo owner ([@terence-c](https://github.com/terence-c)) to add your GitHub account as a collaborator: cloning works without it, pushing doesn't.
2. Clone and install:
   ```
   git clone https://github.com/terence-c/reap-hackathon-09oct.git
   cd reap-hackathon-09oct
   npm install
   ```
3. Check the SQLite driver loads: `node -e "new (require('better-sqlite3'))(':memory:')"`. If it errors, your npm probably skips install scripts (`npm config get ignore-scripts` prints `true`), so better-sqlite3's native build never ran. Fix it with `cd node_modules/better-sqlite3 && npx prebuild-install`, then `cd ../..`.
4. Run `cp .env.example .env.local`, then fill in the values from [Keys](#keys). Never commit this file.
5. Run `npm run dev:https` and open https://localhost:3443; you should see "AgentCart". The first run may ask you to trust a local certificate (Next.js makes one with mkcert and may ask for your password to add it to the keychain); accept it. Reap only sends people back to HTTPS addresses, and it accepts `https://localhost`, so no tunnel is needed. Plain `npm run dev` (http://localhost:3000) is fine for UI work but cannot complete a card setup or a checkout.

## Keys

Up to four blanks in `.env.local` need a value; everything else is preset, including `APP_BASE_URL=https://localhost:3443` and `DEMO_EMAIL=demo@example.com` (Reap rejects `.test` addresses). Until a key arrives, the dev server still boots, because Reap and LLM keys are only checked when code first uses them.

| Variable | What it is | Where it comes from |
| --- | --- | --- |
| `REAP_API_KEY` | Reap sandbox API key | Reap desk, when the team registers |
| `OPENAI_API_KEY` | LLM key | platform.openai.com → API keys (needs billing credit), or OpenRouter, Groq, etc. |
| `REAP_ENROLLMENT_ID` | The card enrollment (optional) | Usually not needed: "Add card" in the app stores the card enrollment in `data/safr.db` and the gate uses it. Set this only to reuse a card from `npm run enroll` or another laptop; `npm run e2e` and `npm run smoke` need it |
| `AGENT_PRIVATE_KEY` | Ed25519 key that signs every envelope | Printed by `npm run keygen`; the public half goes into the committed registry. Everyone running the app uses the same key, so if it is regenerated, everyone updates |
| `APP_BASE_URL` | Where Reap sends the user back after its card and approval pages | Preset to `https://localhost:3443`, served by `npm run dev:https`. Must be HTTPS: Reap rejects `http://` |

- Share the API keys, enrollment ID and private key in a private chat, never in `NOTES.md` or a commit: this repo is public.
- Also from the Reap desk: the sandbox test card number (listed in `NOTES.md`), typed once on Reap's hosted page and never stored by AgentCart.
- Leave `REAP_BASE_URL`, `REAP_API_VERSION` (`2025-02-14`, from Reap's API reference), `DEMO_EMAIL` and `AGENT_ID` as they are. For another LLM provider, change `OPENAI_BASE_URL` and `OPENAI_MODEL` together; the model must support tool calling.

## Run a real checkout

On the laptop that runs the demo, in this order:

1. Fill in `.env.local` (see [Keys](#keys)): at least `REAP_API_KEY` and `OPENAI_API_KEY`. Leave `APP_BASE_URL=https://localhost:3443`.
2. Run `npm run keygen`. If it prints an `AGENT_PRIVATE_KEY=` line, paste it into `.env.local`.
3. In one terminal, run `npm run dev:https` and open https://localhost:3443. Trust the local certificate if asked.
4. Add the card from the app: click "Add card" in the panel, then enter the Reap sandbox test card on Reap's page (OTP `456789` if asked). Reap sends you back to `/orders/enrollment-done`, which says when the card is ready. AgentCart never sees the card details.
   - CLI alternative: in a second terminal, run `npm run enroll`, open the printed link, enter the same test card, then paste the printed `REAP_ENROLLMENT_ID=` line into `.env.local` and restart `npm run dev:https`.
5. Optional: check the Reap side on its own with `npm run e2e` (quote, checkout, wait for COMPLETED; it prints the order ID). `npm run e2e` and `npm run smoke` read only `REAP_ENROLLMENT_ID` from `.env.local`, so they need the CLI route in step 4 (`npm run enroll` prints that line). If you added the card from the app, skip them.

After a purchase, Reap sends the browser to `/orders/done`, which keeps asking Reap for the status and only shows the order number once Reap says COMPLETED.

## Rules

Commit small, pull before you push, and keep secrets out of git: this repo and everything in it is public.

- Commit small and often; run `git pull --rebase` before every `git push`.
- Never commit `.env.local`, keys or the enrollment ID. `NOTES.md` is public too: Reap's answers go there, secrets don't.
- `package-lock.json` is deliberately not in git; don't force-add it.
- No new npm packages without telling the team.
- `lib/types.ts` is the shared contract; change it only after telling the team.
- The LLM never gets a tool that calls Reap's checkout, money is integer cents, and nothing counts as ordered until Reap returns COMPLETED.
