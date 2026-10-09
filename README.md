# AgentCart

AI purchasing agent with runtime governance. Built for the Reap × 65labs Agentic Buildathon, Singapore, 9 Oct 2026.

The agent discovers products, gets real merchant quotes through Reap Agentic Payments, and proposes a checkout. A SAFR gateway (agent identity, controls repository, disposition engine, hash-chained audit log) decides Deny / Escalate / Auto-execute / Observe before anything reaches the payment rail.

See `AGENTS.md` for lane ownership and rules, `TODO-A/B/C-*.md` for the build plan.

## Quick start

```
npm install
cp .env.example .env.local
npm run dev
```
