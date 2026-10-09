// The one LLM for the agent: any OpenAI-compatible endpoint, configured via OPENAI_* in .env.local.
// Swap the provider here if the endpoint misbehaves; nothing else imports a vendor SDK.

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { env } from "@/lib/env";

const provider = createOpenAICompatible({
  name: "llm",
  baseURL: env.OPENAI_BASE_URL,
  apiKey: env.OPENAI_API_KEY,
});

export const model = provider(env.OPENAI_MODEL);
