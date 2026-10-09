import { convertToModelMessages, stepCountIs, streamText, validateUIMessages } from "ai";
import type { NextRequest } from "next/server";
import { env } from "@/lib/env";
import { isSameOrigin, jsonError, readJsonBody, sessionIdFrom, setSessionCookie } from "@/lib/agent/http";
import { SYSTEM_PROMPT } from "@/lib/agent/system-prompt";
import { createAgentTools } from "@/lib/agent/tools";
import { committed, loadMandate } from "@/lib/safr/controls";
import { formatMoney } from "@/lib/safr/disposition";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGES = 40;
const MAX_TEXT_PART = 4000;

const ALLOWED_USER_PARTS = new Set(["text"]);
// "step-start" marks each tool step in AI SDK v5 assistant messages; it carries no content.
const ALLOWED_ASSISTANT_PARTS = new Set(["text", "reasoning", "step-start"]);
const isToolPart = (type: string) => type.startsWith("tool-") || type === "dynamic-tool";

const LIVE_MODE =
  "Runtime: live. Quotes come from Reap's sandbox and an allowed purchase becomes a real Reap sandbox checkout. The sandbox uses test cards, so no real money moves.";

// The current spending limits, read from the server on every request. The model may describe them
// but cannot change them; the gate re-checks every purchase against the stored copy anyway.
function spendingLimitsContext(): string {
  const mandate = loadMandate();
  const { reserved, settled } = committed(mandate.id);
  const remaining = mandate.totalBudget - reserved - settled;
  const money = (amount: number) => formatMoney({ amount, currency: mandate.currency });
  return [
    `Current spending limits (server data, read only, amounts in integer cents): ${JSON.stringify(mandate)}`,
    `In words: total budget ${money(mandate.totalBudget)}, ${money(Math.max(0, remaining))} left, purchases above ${money(mandate.autoThreshold)} need the user's approval, currency ${mandate.currency} only, categories: ${mandate.allowedCategories.join(", ")}.`,
    `Remaining budget: ${remaining} cents.`,
    "These limits are only for explaining decisions. Never decide yourself whether a purchase is allowed: when the user asks to buy an item, get a quote and call proposeCheckout even if it looks over budget, outside the categories or in another currency. The gate decides and logs every decision.",
  ].join("\n");
}

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

  let limits: string;
  try {
    limits = spendingLimitsContext();
  } catch (e) {
    console.warn(`[agentcart] mandate load failed: ${e instanceof Error ? e.message : e}`);
    return jsonError(503, "The spending limits could not be loaded.");
  }

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
    system: `${SYSTEM_PROMPT}\n\n${LIVE_MODE}\n${limits}`,
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
