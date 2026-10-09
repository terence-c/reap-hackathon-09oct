import { getOrCreateSession, recordToolEvent, stubRegistry } from "./stubs";

export type ToolContext = { agentId: string; sessionId: string };

export async function dispatchTool(
  ctx: ToolContext,
  toolName: string,
  input: unknown,
  runner: () => unknown | Promise<unknown>,
): Promise<unknown> {
  const session = getOrCreateSession(ctx.sessionId);
  if (!stubRegistry.isToolAllowed(ctx.agentId, toolName, ctx.sessionId)) {
    console.warn(`[agentcart] TOOL_DENIED agent=${ctx.agentId} tool=${toolName}`);
    recordToolEvent(session, "TOOL_DENIED", ctx.agentId, toolName);
    return {
      error: "This shopping action is not available. The assistant may be paused.",
    };
  }
  recordToolEvent(session, "TOOL_CALL", ctx.agentId, toolName);
  return runner();
}
