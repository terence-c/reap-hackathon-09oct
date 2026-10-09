// Typed, validated env. Import `env` from here; never read process.env or hardcode the Reap host.
// REAP_* and OPENAI_API_KEY are validated lazily (on first access) so `npm run dev` boots
// before the keys are filled in. Everything else is validated once, at import.

import { z } from "zod";

// `KEY=` in .env.local arrives as "" — treat it as unset so defaults and optionals apply.
const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const required = z.preprocess(blank, z.string().min(1));
const optional = z.preprocess(blank, z.string().optional());
const withDefault = (value: string) => z.preprocess(blank, z.string().default(value));
const urlWithDefault = (value: string) => z.preprocess(blank, z.string().url().default(value));

const appSchema = z.object({
  APP_BASE_URL: urlWithDefault("http://localhost:3000"),
  DEMO_EMAIL: withDefault("demo@agentcart.test"),
  AGENT_ID: withDefault("purchasing-agent-v1"),
  AGENT_PRIVATE_KEY: optional,
  // Eager (with defaults) so the registry can read OPENAI_MODEL at startup without the key.
  OPENAI_BASE_URL: urlWithDefault("https://api.openai.com/v1"),
  OPENAI_MODEL: withDefault("gpt-6-luna"),
});

const reapSchema = z.object({
  REAP_API_KEY: required,
  REAP_BASE_URL: urlWithDefault("https://sg.sandbox.api.reap.global"),
  REAP_API_VERSION: withDefault("2025-02-14"),
  REAP_ENROLLMENT_ID: optional,
});

const llmSchema = z.object({
  OPENAI_API_KEY: required,
});

function parse<T extends z.ZodTypeAny>(schema: T): z.infer<T> {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
    throw new Error(
      `Missing or invalid env vars: ${names.join(", ")}. Set them in .env.local (see .env.example).`,
    );
  }
  return result.data;
}

function lazy<T extends z.ZodTypeAny>(schema: T): () => z.infer<T> {
  let cached: z.infer<T> | undefined;
  return () => (cached ??= parse(schema));
}

const reap = lazy(reapSchema);
const llm = lazy(llmSchema);

export const env = {
  ...parse(appSchema),
  get REAP_API_KEY(): string {
    return reap().REAP_API_KEY;
  },
  get REAP_BASE_URL(): string {
    return reap().REAP_BASE_URL;
  },
  get REAP_API_VERSION(): string {
    return reap().REAP_API_VERSION;
  },
  get REAP_ENROLLMENT_ID(): string | undefined {
    return reap().REAP_ENROLLMENT_ID;
  },
  get OPENAI_API_KEY(): string {
    return llm().OPENAI_API_KEY;
  },
};
