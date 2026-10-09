// Browser-side helpers for /api/agent/state. Type-only imports from lib/safr and lib/reap so no
// server code (SQLite, env) is bundled into the client.

import type { AuditEntry, Mandate } from "@/lib/types";
import type { PendingApproval } from "@/lib/safr/gate";
import type { ToolEvent } from "@/lib/safr/registry";
import type { Enrollment } from "@/lib/reap/enrollments";

export type { Enrollment, PendingApproval, ToolEvent };

export type AgentStateResponse = {
  mode: "live";
  mandate: Mandate;
  remainingBudget: number;
  registry: {
    agentId: string;
    owner: string;
    model: string;
    promptHash: string;
    publicKeyFingerprint: string | null;
    status: "active" | "revoked";
  };
  audit: AuditEntry[];
  toolEvents: ToolEvent[];
  chainVerified: boolean;
  approvals: PendingApproval[];
  enrollment: Enrollment | null;
};

export async function fetchAgentState(): Promise<AgentStateResponse> {
  const response = await fetch("/api/agent/state", { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not refresh details (${response.status})`);
  return response.json();
}

export async function patchAgentState(body: unknown): Promise<AgentStateResponse> {
  const response = await fetch("/api/agent/state", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? `Could not save changes (${response.status})`);
  }
  return response.json();
}
