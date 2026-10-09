import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { isSameOrigin, jsonError, readJsonBody, sessionIdFrom, setSessionCookie } from "@/lib/agent/http";
import {
  getOrCreateSession,
  promptHash,
  updateMandate,
  verifyAuditChain,
  type Session,
} from "@/lib/agent/stubs";

export type StubState = ReturnType<typeof serializeState>;

function serializeState(session: Session) {
  return {
    mode: "stub" as const,
    mandate: session.mandate,
    remainingBudget: session.mandate.totalBudget,
    registry: {
      agentId: env.AGENT_ID,
      owner: session.mandate.principalId,
      model: env.OPENAI_MODEL,
      promptHash: promptHash(),
      publicKeyFingerprint: null,
      status: session.mandate.killSwitch ? ("revoked" as const) : ("active" as const),
    },
    audit: session.audit,
    toolEvents: session.toolEvents,
    chainVerified: verifyAuditChain(session),
  };
}

export async function GET(request: NextRequest) {
  const { id: sessionId, isNew } = sessionIdFrom(request);
  const session = getOrCreateSession(sessionId);
  const response = NextResponse.json(serializeState(session), {
    headers: { "cache-control": "no-store" },
  });
  if (isNew) setSessionCookie(response, sessionId);
  return response;
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
    return jsonError(400, `Invalid mandate update: ${parsed.error.issues[0]?.message ?? "bad shape"}`);
  }

  const { id: sessionId, isNew } = sessionIdFrom(request);
  const session = getOrCreateSession(sessionId);

  if (parsed.data.action === "updateMandate") {
    updateMandate(session, parsed.data.mandate);
  } else if (parsed.data.action === "revoke") {
    session.mandate = { ...session.mandate, killSwitch: true, version: session.mandate.version + 1 };
  } else {
    session.mandate = { ...session.mandate, killSwitch: false, version: session.mandate.version + 1 };
  }

  const response = NextResponse.json(serializeState(session), {
    headers: { "cache-control": "no-store" },
  });
  if (isNew) setSessionCookie(response, sessionId);
  return response;
}
