# AgentCart — instructions for any AI coding agent working in this repo

AgentCart is a Reap × 65labs Agentic Buildathon entry (9 Oct 2026, 3 hours, 3 people).
An AI purchasing agent that can only reach Reap's sandbox checkout through a SAFR
governance gate (MAS "Safeguards for Agentic Finance at Runtime" white paper).

## Who owns what — do not edit another lane's folders

| Lane | Person | Owns | To-do list |
|------|--------|------|------------|
| A | Reap adapter | `lib/reap/`, `scripts/enroll.ts`, `scripts/e2e.ts`, `app/api/checkout/`, `app/orders/` | `TODO-A-reap-adapter.md` |
| B | SAFR core | `lib/safr/`, `lib/types.ts`, `tests/`, `scripts/keygen.ts`, `app/api/approvals/`, `app/api/registry/`, `app/api/audit/` | `TODO-B-safr-core.md` |
| C | Agent + UI | `lib/agent/`, `lib/catalog.json`, `app/page.tsx`, `app/components/`, `app/api/agent/`, `PITCH.md` | `TODO-C-agent-and-ui.md` |

Shared, read-only for everyone except B: `lib/types.ts`. Shared notes: `NOTES.md`.

## Non-negotiable rules

1. The LLM never gets a tool that calls Reap's checkout. `proposeCheckout` only asks the gate.
2. Amounts, merchant and category are always re-derived server-side from the quote and catalog. Never trust numbers from the model.
3. Money is integer cents. Currency is checked against the mandate.
4. The audit entry is appended BEFORE any Reap call, including on DENY.
5. Never claim an order succeeded until `GET /agentic/checkouts/:id` returns `COMPLETED`.
6. Sandbox only. `X-Simulate-Checkout` is never sent outside sandbox.
7. No new dependencies beyond `package.json` without telling the team.

## Workflow

- Work through your lane's TODO file top to bottom. Stop and report at each "Exit criterion".
- Before integration (Sync 1 at 1:20), code against stubs/mocks with the exact interfaces in `lib/types.ts`.
- Commit small and often to `main`. Pull before you push. Folder ownership prevents conflicts.

## Commands

```
npm install
cp .env.example .env.local   # then fill it in
npm run dev                  # http://localhost:3000
npm test                     # vitest
npm run keygen               # Role B: Ed25519 agent keypair
npm run enroll               # Role A: create EXTERNAL enrollment, open hosted page, wait for ACTIVE
npm run e2e                  # Role A: quote → checkout → poll, prints orderId
```

Reap base URL is https://sg.sandbox.api.reap.global — always import it from lib/env.ts, never hardcode.


## Setup notes (verified on this machine)

- AI SDK v5 is pinned (`ai@5.0.271`, `@ai-sdk/react@2.0.274`): use `stopWhen: stepCountIs(6)` — `maxSteps` no longer exists. `useChat` takes a `DefaultChatTransport({ api })` transport.
- Run `npx next typegen` (or `next dev`/`build`) before `tsc` — global `PageProps`/`LayoutProps` helpers are generated into `.next/types`.
- Role C's extra tests live outside the repo (temporary vitest config + specs under /tmp); they are not part of `npm test`.
- `OPENAI_API_KEY` in `.env.local` must be non-empty for `POST /api/agent` to stream; the route returns 503 until it is set. `GET/PATCH /api/agent/state` is the stub state endpoint until Role B's `/api/registry` and `/api/audit` exist.
- Dev server may be on a non-3000 port if 3000 is taken; check with `lsof -iTCP:<port> -sTCP:LISTEN`.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## UI preferences

- Light theme with colorful pastel accents; no dark panels.
- Plain, human language in user-facing copy; avoid technical jargon.
- Never use em dashes or en dashes in user-facing text.
