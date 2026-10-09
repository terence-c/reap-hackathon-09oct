import { convertToModelMessages, stepCountIs, streamText, validateUIMessages } from "ai";
import type { NextRequest } from "next/server";
import { env } from "@/lib/env";
import { isSameOrigin, jsonError, readJsonBody, sessionIdFrom, setSessionCookie } from "@/lib/agent/http";
import { SYSTEM_PROMPT } from "@/lib/agent/system-prompt";
import { createAgentTools } from "@/lib/agent/tools";
import { getOrCreateSession } from "@/lib/agent/stubs";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGES = 40;
const MAX_TEXT_PART = 4000;

const ALLOWED_USER_PARTS = new Set(["text"]);
const ALLOWED_ASSISTANT_PARTS = new Set(["text", "reasoning"]);
const isToolPart = (type: string) => type.startsWith("tool-") || type === "dynamic-tool";

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return jsonError(403, "Cross-origin requests are not allowed.");
  }

  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) {
    return jsonError(
      body.reason === "too-large" ? 413 : 400,
      body.reason === "too-large" ? "Request body too large." : "Request body must be valid JSON.",
    );
  }

  const messages = (body.value as { messages?: unknown })?.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    return jsonError(400, "Provide between 1 and 40 messages.");
  }

  let uiMessages;
  try {
    uiMessages = await validateUIMessages({ messages });
  } catch {
    return jsonError(400, "Messages are malformed.");
  }
  for (const message of uiMessages) {
    if (message.role === "system") return jsonError(400, "System messages are not accepted.");
    if (message.role === "user") {
      for (const part of message.parts) {
        if (!ALLOWED_USER_PARTS.has(part.type)) {
          return jsonError(400, "Only text parts are accepted from the user.");
        }
      }
    } else {
      for (const part of message.parts) {
        if (!ALLOWED_ASSISTANT_PARTS.has(part.type) && !isToolPart(part.type)) {
          return jsonError(400, "Unsupported message part.");
        }
      }
    }
    for (const part of message.parts) {
      if (part.type === "text" && part.text.length > MAX_TEXT_PART) {
        return jsonError(400, "A message text part exceeds the length limit.");
      }
    }
  }

  const { id: sessionId, isNew } = sessionIdFrom(request);
  const session = getOrCreateSession(sessionId);

  let model;
  try {
    ({ model } = await import("@/lib/agent/model"));
  } catch (e) {
    console.warn(`[agentcart] model load failed: ${e instanceof Error ? e.message : e}`);
    return jsonError(503, "The LLM provider is not configured. Set OPENAI_* in .env.local.");
  }

  let modelMessages;
  try {
    modelMessages = await convertToModelMessages(uiMessages);
  } catch {
    return jsonError(400, "Messages could not be converted for the model.");
  }

  const result = streamText({
    model,
    system: `${SYSTEM_PROMPT}\n\nRuntime mode: stub. Governance is simulated; no real Reap checkout exists.\nServer-authoritative session mandate: ${JSON.stringify(session.mandate)}`,
    messages: modelMessages,
    tools: createAgentTools({ agentId: env.AGENT_ID, sessionId }),
    providerOptions: { llm: { reasoningEffort: "none" } },
    stopWhen: stepCountIs(6),
  });

  const response = result.toUIMessageStreamResponse({
    onError: () => "The model stream failed.",
  });
  if (isNew) setSessionCookie(response, sessionId);
  return response;
}
