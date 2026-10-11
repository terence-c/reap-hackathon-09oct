// Clean slate for a demo run: empties the activity log, budget holds, approvals, tool calls and
// quote records; restores the demo mandate; makes the agent ACTIVE and refreshes its model and
// prompt hash. Keeps the agent's registered public key and the saved Reap card enrollment.

import demoMandate from "../mandate.demo.json";
import { env } from "../env";
import { computePromptHash, db } from "./db";
import { setAgentStatus } from "./registry";

export type ResetResult = { keyRegistered: boolean; cardReady: boolean };

export function resetDemo(): ResetResult {
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
  database.prepare(`UPDATE agents SET prompt_hash = ?, model = ? WHERE agent_id = ?`).run(computePromptHash(), env.OPENAI_MODEL, env.AGENT_ID);
  const key = database.prepare(`SELECT public_key FROM agents WHERE agent_id = ?`).get(env.AGENT_ID) as
    | { public_key: string | null }
    | undefined;
  const card = database.prepare(`SELECT 1 FROM reap_enrollments WHERE status = 'ACTIVE' LIMIT 1`).get();
  return { keyRegistered: !!key?.public_key, cardReady: !!card || !!env.REAP_ENROLLMENT_ID || env.REAP_MODE !== "live" };
}
