import { authorizeToolCall } from "@/lib/safr/registry";

export type ToolContext = { agentId: string; sessionId: string };

// Every tool call goes through the registry first: it checks the agent's allowlist and records the
// call (that record becomes the envelope's toolTrace). A disallowed tool is logged as TOOL_DENIED
// by the registry and the model only gets a plain error back.
export async function dispatchTool(
  ctx: ToolContext,
  toolName: string,
  runner: () => unknown | Promise<unknown>,
): Promise<unknown> {
  const allowed = authorizeToolCall({ sessionId: ctx.sessionId, agentId: ctx.agentId, tool: toolName });
  if (!allowed) return { error: "This shopping action is not available." };
  return runner();
}
