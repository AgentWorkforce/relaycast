import { logger } from "@/lib/logger";

type MatchedAgentRef = {
  id: string;
};

type SlackConversationDispatchResult = {
  matched: number;
  delivered: number;
  failed: number;
};

type MatchedDispatchContext = {
  workspaceId: string;
  relayWorkspaceId: string | null;
  provider: string;
  eventType: string;
  deliveryId: string;
  matched: MatchedAgentRef[];
};

// Injectable info sink (see SlackConversationDispatchDeps.logWarn for why
// tests must inject rather than mock the logger module).
type FinalizeDeps = {
  logInfo?: (message: string, fields: Record<string, unknown>) => Promise<void> | void;
};

export async function logIntegrationWatchMatchedAgents(
  input: MatchedDispatchContext,
  deps: FinalizeDeps = {},
): Promise<void> {
  const logInfo = deps.logInfo ??
    ((message: string, fields: Record<string, unknown>) => logger.info(message, fields));
  await logInfo("Integration watch dispatch matched agents", {
    area: "integration-watch-dispatch",
    diag: "matched",
    workspaceId: input.workspaceId,
    relayWorkspaceId: input.relayWorkspaceId ?? undefined,
    provider: input.provider,
    eventType: input.eventType,
    deliveryId: input.deliveryId,
    matchedCount: input.matched.length,
    matchedIds: input.matched.map((row) => row.id),
  });
}

export async function finalizeSlackConversationDispatchResult(input: MatchedDispatchContext & {
  result: SlackConversationDispatchResult | null;
}, deps: FinalizeDeps = {}): Promise<SlackConversationDispatchResult | null> {
  if (!input.result) {
    return null;
  }

  if (input.matched.length > 0) {
    await logIntegrationWatchMatchedAgents(input, deps);
  }

  return input.result;
}
