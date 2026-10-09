import type { AuditEntry, Mandate } from "@/lib/types";
import type { ToolEvent } from "./stubs";

export type StubStateResponse = {
  mode: "stub";
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
};

export async function fetchStubState(): Promise<StubStateResponse> {
  const response = await fetch("/api/agent/state", { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not refresh details (${response.status})`);
  return response.json();
}

export async function patchStubState(body: unknown): Promise<StubStateResponse> {
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
