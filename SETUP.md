# AgentCart Team Setup

Clone the repo, put your lane's keys in `.env.local`, drop in your TODO file, and build against stubs until Sync 1 at 1:20. Sync 0 is done except Lane A's trip to the Reap desk for the sandbox API key and test card.

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
4. Run `cp .env.example .env.local`, then fill in what your lane needs from [Keys](#keys). Never commit this file.
5. Save the TODO file you were sent over chat into the repo root (`TODO-A-reap-adapter.md`, `TODO-B-safr-core.md` or `TODO-C-agent-and-ui.md`). It is gitignored on purpose.
6. Run `npm run dev:https` and open https://localhost:3443; you should see "AgentCart". The first run may ask you to trust a local certificate (Next.js makes one with mkcert and may ask for your password to add it to the keychain); accept it. Reap only sends people back to HTTPS addresses, and it accepts `https://localhost`, so no tunnel is needed. Plain `npm run dev` (http://localhost:3000) is fine for UI work but cannot complete a card setup or a checkout.
7. Tell your AI coding agent: "Read AGENTS.md and my TODO file, work top to bottom, stop at each exit criterion." AGENTS.md holds the folder ownership and the seven rules it must follow.

## Keys

Up to four blanks in `.env.local` need a value; everything else is preset, including `APP_BASE_URL=https://localhost:3443` and `DEMO_EMAIL=demo@example.com` (Reap rejects `.test` addresses). Until a key arrives, the dev server still boots, because Reap and LLM keys are only checked when code first uses them.

| Variable | What it is | Where it comes from | Who gets it | Who needs it |
| --- | --- | --- | --- | --- |
| `REAP_API_KEY` | Reap sandbox API key | Reap desk, when the team registers | A, at Sync 0 | A from the start; B and C from 1:30 |
| `OPENAI_API_KEY` | LLM key | platform.openai.com → API keys (needs billing credit), or OpenRouter, Groq, etc. | C, before Build | C from the start; the demo laptop |
| `REAP_ENROLLMENT_ID` | The team's card enrollment (optional) | Usually not needed: "Add card" in the app stores the card enrollment in `data/safr.db` and the gate uses it. Set this only to reuse a card from `npm run enroll` or another laptop | A, during Build | `npm run e2e`, `npm run smoke`, or a laptop that skipped "Add card" |
| `AGENT_PRIVATE_KEY` | Ed25519 key that signs every envelope | B writes and runs `npm run keygen`; the public half goes into the committed registry | B, during Build | Everyone once B's gate is wired in, from 1:30; if B regenerates it, everyone updates |
| `APP_BASE_URL` | Where Reap sends the user back after its card and approval pages | Preset to `https://localhost:3443`, served by `npm run dev:https`. Must be HTTPS: Reap rejects `http://` | Preset | The laptop that runs checkouts and the demo |

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

## Lanes

Three lanes, one owner each. Edit only your own folders so commits straight to `main` never collide.

| Lane | Owns | TODO file | Start with | Sync 1 exit criterion (1:20) |
| --- | --- | --- | --- | --- |
| A · Reap adapter | `lib/reap/`, `scripts/enroll.ts`, `scripts/e2e.ts`, `app/api/checkout/`, `app/orders/` | `TODO-A-reap-adapter.md` | Reap desk: API key, test card, and the open questions in `NOTES.md`; then `lib/reap/client.ts` (Reap's real request shapes are in `NOTES.md` under Gotchas) | `npm run e2e` prints a COMPLETED checkout with an order ID |
| B · SAFR core | `lib/safr/`, `lib/types.ts`, `tests/`, `scripts/keygen.ts`, `app/api/approvals/`, `app/api/registry/`, `app/api/audit/` | `TODO-B-safr-core.md` | `lib/types.ts` is already in the repo, so review it; then `lib/safr/registry.ts` and `npm run keygen` | All disposition tests pass (`npm test`) against a hand-made fake quote |
| C · Agent + UI | `lib/agent/`, `lib/catalog.json`, `app/page.tsx`, `app/components/`, `app/api/agent/`, `PITCH.md` | `TODO-C-agent-and-ui.md` | `lib/agent/system-prompt.ts`, then `tools.ts`, `router.ts` and `app/api/agent/route.ts`, using the model from `lib/agent/model.ts` | "buy True Singapore Ghost Stories Book 12" makes the agent list, quote and propose, and the panel shows a stubbed AUTO_EXECUTE with an envelope |

Until Sync 1, code against the `ReapAdapter` and `Gate` interfaces in `lib/types.ts` with stubs, so no lane waits on another.

## Timeline

Times from the start of the 3-hour build. Only Lane A has Sync 0 work left; after Sync 1 the lanes plug into each other, so hit your exit criterion on time.

| When | A · Reap adapter | B · SAFR core | C · Agent + UI |
| --- | --- | --- | --- |
| **Sync 0** · 0:00–0:15 | Reap desk: API key, test card | `lib/types.ts` (done) | Scaffold and catalog (done) |
| **Build** · 0:15–1:20, against stubs | client, enroll, quotes, checkouts, e2e script | registry, envelope, controls, disposition, audit log and tests | system prompt, tools, router, agent route, two-pane page |
| **◆ Sync 1 · 1:20** | Each lane meets its exit criterion; stubs get swapped for real calls | | |
| **Integrate** · 1:30–2:10 | checkout status route, `/orders/done` page, local HTTPS for `returnUrl` | `gate.ts`, approvals API, registry and audit APIs | real calls, approve card, kill switch, `PITCH.md` |
| **◆ Sync 2 · 2:10** | The 8-step demo runs end to end on one laptop | | |
| **Polish** · 2:20–2:45 | keep `npm run dev:https` running, fix demo breakers only | no new rules, identity pitch lines | visual fixes, architecture slide |
| **◆ Sync 3 · 2:45** | Freeze, submit, rehearse the pitch once with a timer | | |

## Rules

Commit small, pull before you push, and keep secrets out of git: this repo and everything in it is public.

- Commit small and often to `main`; run `git pull --rebase` before every `git push`.
- Never commit `.env.local`, keys or the enrollment ID. `NOTES.md` is public too: Reap's answers go there, secrets don't.
- `package-lock.json` and the TODO files are deliberately not in git; don't force-add them.
- No new npm packages without telling the team (AGENTS.md rule 7).
- `lib/types.ts` belongs to B; everyone else reads it and asks B for changes.
- The LLM never gets a tool that calls Reap's checkout, money is integer cents, and nothing counts as ordered until Reap returns COMPLETED. All seven rules are in AGENTS.md.
