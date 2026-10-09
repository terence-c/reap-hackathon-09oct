// The one LLM for the agent: any OpenAI-compatible endpoint, configured via OPENAI_* in .env.local.
// Swap the provider here if the endpoint misbehaves; nothing else imports a vendor SDK.

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { env } from "@/lib/env";

const provider = createOpenAICompatible({
  name: "llm",
  baseURL: env.OPENAI_BASE_URL,
  apiKey: env.OPENAI_API_KEY,
  // GPT-6 models only allow tool calls on Chat Completions with reasoning_effort "none"
  // (OpenAI model docs). Older models reject the field, so only GPT-6 gets it.
  transformRequestBody: (body) =>
    env.OPENAI_MODEL.includes("gpt-6") ? { ...body, reasoning_effort: body.reasoning_effort ?? "none" } : body,
});

export const model = provider(env.OPENAI_MODEL);
