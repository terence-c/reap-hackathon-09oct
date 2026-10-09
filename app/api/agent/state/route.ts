// Live SAFR state for the UI panel: the mandate and what's left of it, the agent's registry entry,
// the hash-chained activity log, tool events, pending approvals and the payment card. Mandate and
// audit are global (one demo principal), not per chat session.

import { connection, NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { isSameOrigin, jsonError, readJsonBody } from "@/lib/agent/http";
import type { AgentStateResponse } from "@/lib/agent/state-client";
import { list, verifyChain } from "@/lib/safr/audit";
import { committed, loadMandate, saveMandate } from "@/lib/safr/controls";
import { gate } from "@/lib/safr/gate";
import { getAgent, listToolEvents, setAgentStatus } from "@/lib/safr/registry";
import { currentEnrollment } from "@/lib/reap/enrollments";

function liveState(): AgentStateResponse {
  const mandate = loadMandate();
  const { reserved, settled } = committed(mandate.id);
  const agent = getAgent(env.AGENT_ID);
  return {
    mode: "live",
    mandate,
    remainingBudget: mandate.totalBudget - reserved - settled,
    registry: agent
      ? {
          agentId: agent.agentId,
          owner: agent.owner,
          model: agent.model,
          promptHash: agent.promptHash,
          publicKeyFingerprint: agent.publicKeyFingerprint,
          status: agent.status === "ACTIVE" ? "active" : "revoked",
        }
      : {
          // Not in the registry: the gate denies it as an unknown agent, so show it as paused.
          agentId: env.AGENT_ID,
          owner: "Unknown",
          model: env.OPENAI_MODEL,
          promptHash: "",
          publicKeyFingerprint: null,
          status: "revoked",
        },
    audit: list(),
    toolEvents: listToolEvents(),
    chainVerified: verifyChain().ok,
    approvals: gate.listPendingApprovals(),
    enrollment: currentEnrollment(),
  };
}

function stateResponse(): NextResponse {
  return NextResponse.json(liveState(), { headers: { "cache-control": "no-store" } });
}

export async function GET() {
  await connection();
  return stateResponse();
}

const isoDate = z.string().datetime({ offset: true });

const mandatePatchSchema = z
  .object({
    currency: z.enum(["SGD", "USD"]),
    totalBudget: z.number().int().min(0).max(1_000_000_000),
    autoThreshold: z.number().int().min(0).max(1_000_000_000),
    allowedCategories: z.array(z.string().min(1).max(80)).min(1).max(20),
    validFrom: isoDate,
    validTo: isoDate,
  })
  .refine((m) => Date.parse(m.validFrom) < Date.parse(m.validTo), {
    message: "validFrom must be before validTo",
  })
  .refine((m) => m.autoThreshold <= m.totalBudget, {
    message: "autoThreshold must be at or below totalBudget",
  });

const patchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("updateMandate"), mandate: mandatePatchSchema }),
  z.object({ action: z.literal("revoke") }),
  z.object({ action: z.literal("restore") }),
]);

export async function PATCH(request: NextRequest) {
  await connection();
  if (!isSameOrigin(request)) {
    return jsonError(403, "Cross-origin requests are not allowed.");
  }
  const body = await readJsonBody(request, 64 * 1024);
  if (!body.ok) {
    return jsonError(
      body.reason === "too-large" ? 413 : 400,
      body.reason === "too-large" ? "Request body too large." : "Request body must be valid JSON.",
    );
  }
  const parsed = patchSchema.safeParse(body.value);
  if (!parsed.success) {
    return jsonError(400, `Invalid update: ${parsed.error.issues[0]?.message ?? "bad shape"}`);
  }

  try {
    if (parsed.data.action === "updateMandate") {
      // saveMandate validates, bumps the version and persists; the stored version is never trusted.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { version, ...current } = loadMandate();
      saveMandate({ ...current, ...parsed.data.mandate });
    } else {
      setAgentStatus(env.AGENT_ID, parsed.data.action === "revoke" ? "REVOKED" : "ACTIVE");
    }
  } catch (error) {
    return jsonError(400, error instanceof Error ? error.message : "The update could not be saved.");
  }

  return stateResponse();
}
