// SAFR component 1 — Agent Identity. Who the agent is, what it may do, and the public key its
// envelopes must verify against. Status is enforced at the gate (DENY IDENTITY_REVOKED), not
// here, so a revoked agent's proposal still reaches the gate and is logged.

import { createHash } from "node:crypto";
import { db } from "./db";

export type AgentStatus = "ACTIVE" | "REVOKED";

export type AgentRecord = {
  agentId: string;
  displayName: string;
  owner: string;
  model: string;
  promptHash: string;
  allowedTools: string[];
  allowedActionTypes: string[];
  principals: string[];
  publicKey: string | null; // base64 SPKI DER; null until `npm run keygen`
  publicKeyFingerprint: string | null;
  status: AgentStatus;
  updatedAt: string;
};

type AgentRow = {
  agent_id: string;
  display_name: string;
  owner: string;
  model: string;
  prompt_hash: string;
  allowed_tools: string;
  allowed_action_types: string;
  principals: string;
  public_key: string | null;
  status: AgentStatus;
  updated_at: string;
};

export function fingerprint(publicKey: string): string {
  return createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
}

function toRecord(row: AgentRow): AgentRecord {
  return {
    agentId: row.agent_id,
    displayName: row.display_name,
    owner: row.owner,
    model: row.model,
    promptHash: row.prompt_hash,
    allowedTools: JSON.parse(row.allowed_tools),
    allowedActionTypes: JSON.parse(row.allowed_action_types),
    principals: JSON.parse(row.principals),
    publicKey: row.public_key,
    publicKeyFingerprint: row.public_key ? fingerprint(row.public_key) : null,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

export function getAgent(agentId: string): AgentRecord | null {
  const row = db().prepare(`SELECT * FROM agents WHERE agent_id = ?`).get(agentId) as AgentRow | undefined;
  return row ? toRecord(row) : null;
}

export function listAgents(): AgentRecord[] {
  return (db().prepare(`SELECT * FROM agents ORDER BY agent_id`).all() as AgentRow[]).map(toRecord);
}

export function setAgentStatus(agentId: string, status: AgentStatus): AgentRecord {
  const result = db()
    .prepare(`UPDATE agents SET status = ?, updated_at = ? WHERE agent_id = ?`)
    .run(status, new Date().toISOString(), agentId);
  if (result.changes === 0) throw new Error(`Unknown agent: ${agentId}`);
  return getAgent(agentId)!;
}

export function registerPublicKey(agentId: string, publicKey: string): AgentRecord {
  const result = db()
    .prepare(`UPDATE agents SET public_key = ?, updated_at = ? WHERE agent_id = ?`)
    .run(publicKey, new Date().toISOString(), agentId);
  if (result.changes === 0) throw new Error(`Unknown agent: ${agentId}`);
  return getAgent(agentId)!;
}

// Allowlist check only. Unknown agent or unlisted tool → false.
export function isToolAllowed(agentId: string, toolName: string): boolean {
  const agent = getAgent(agentId);
  return !!agent && agent.allowedTools.includes(toolName);
}

// ---- Tool trace (feeds envelope.context.toolTrace) and TOOL_DENIED events for C's router ----

export function recordToolCall(input: { sessionId: string; agentId: string; tool: string; allowed: boolean; now?: number }) {
  db()
    .prepare(`INSERT INTO tool_calls (ts, session_id, agent_id, tool, allowed) VALUES (?, ?, ?, ?, ?)`)
    .run(input.now ?? Date.now(), input.sessionId, input.agentId, input.tool, input.allowed ? 1 : 0);
}

// What C's router calls before dispatching any tool: checks the allowlist and records the call.
// Returns false for unknown or disallowed tools; the router then returns an error to the model.
export function authorizeToolCall(input: { sessionId: string; agentId: string; tool: string; now?: number }): boolean {
  const allowed = isToolAllowed(input.agentId, input.tool);
  recordToolCall({ ...input, allowed });
  if (!allowed) console.warn(`[safr] TOOL_DENIED agent=${input.agentId} tool=${input.tool} session=${input.sessionId}`);
  return allowed;
}

export function recordToolDenied(input: { sessionId: string; agentId: string; tool: string; now?: number }) {
  recordToolCall({ ...input, allowed: false });
  console.warn(`[safr] TOOL_DENIED agent=${input.agentId} tool=${input.tool} session=${input.sessionId}`);
}

export function toolTraceFor(sessionId: string, limit = 20): string[] {
  const rows = db()
    .prepare(`SELECT tool FROM tool_calls WHERE session_id = ? AND allowed = 1 ORDER BY id DESC LIMIT ?`)
    .all(sessionId, limit) as { tool: string }[];
  return rows.map((r) => r.tool).reverse();
}

export type ToolDenial = { ts: string; sessionId: string; agentId: string; tool: string };

export function listToolDenials(limit = 50): ToolDenial[] {
  const rows = db()
    .prepare(`SELECT ts, session_id, agent_id, tool FROM tool_calls WHERE allowed = 0 ORDER BY id DESC LIMIT ?`)
    .all(limit) as { ts: number; session_id: string; agent_id: string; tool: string }[];
  return rows.map((r) => ({ ts: new Date(r.ts).toISOString(), sessionId: r.session_id, agentId: r.agent_id, tool: r.tool }));
}

// Every tool call, allowed or denied, oldest first — the activity feed in C's panel.
export type ToolEvent = { seq: number; ts: string; type: "TOOL_CALL" | "TOOL_DENIED"; agentId: string; toolName: string };

export function listToolEvents(limit = 200): ToolEvent[] {
  const rows = db()
    .prepare(`SELECT id, ts, agent_id, tool, allowed FROM tool_calls ORDER BY id DESC LIMIT ?`)
    .all(limit) as { id: number; ts: number; agent_id: string; tool: string; allowed: number }[];
  return rows.reverse().map((r) => ({
    seq: r.id,
    ts: new Date(r.ts).toISOString(),
    type: r.allowed ? "TOOL_CALL" : "TOOL_DENIED",
    agentId: r.agent_id,
    toolName: r.tool,
  }));
}
