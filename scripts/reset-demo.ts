// npm run reset-demo — clean slate for a demo run: empties the activity log, budget holds,
// approvals, tool calls and quote records; restores the demo mandate; makes the agent ACTIVE.
// Keeps the agent's registered public key and the saved Reap card enrollment.
// Safe to run while `next dev` is running (refresh the page afterwards).

import "./load-env";
import demoMandate from "../lib/mandate.demo.json";
import { env } from "../lib/env";
import { computePromptHash, db } from "../lib/safr/db";
import { setAgentStatus } from "../lib/safr/registry";

const database = db();
database.transaction(() => {
  for (const table of ["audit", "reservations", "approvals", "tool_calls", "reap_quotes"]) {
    database.prepare(`DELETE FROM ${table}`).run();
  }
  database
    .prepare(`UPDATE mandates SET version = ?, json = ?, updated_at = ? WHERE id = ?`)
    .run(demoMandate.version, JSON.stringify(demoMandate), new Date().toISOString(), demoMandate.id);
})();
setAgentStatus(env.AGENT_ID, "ACTIVE");
// The prompt hash is read when the DB opens; refresh it in case lib/agent/system-prompt.ts changed.
database.prepare(`UPDATE agents SET prompt_hash = ?, model = ? WHERE agent_id = ?`).run(computePromptHash(), env.OPENAI_MODEL, env.AGENT_ID);

const card = database.prepare(`SELECT status FROM reap_enrollments WHERE status = 'ACTIVE' LIMIT 1`).get() as
  | { status: string }
  | undefined;
const key = database.prepare(`SELECT public_key FROM agents WHERE agent_id = ?`).get(env.AGENT_ID) as
  | { public_key: string | null }
  | undefined;
console.log("Demo reset: activity log empty, budget S$150.00 free, agent ACTIVE.");
console.log(`Agent key registered: ${key?.public_key ? "yes" : "NO (run npm run keygen)"}`);
console.log(`Card ready: ${card || env.REAP_ENROLLMENT_ID ? "yes" : "NO (use Add card in the app)"}`);
