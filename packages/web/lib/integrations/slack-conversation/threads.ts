import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { slackConversationThreads } from "@/lib/db/schema";
import { normalizeSlackChannelId } from "@/lib/integrations/slack-channel-id";
import { logger } from "@/lib/logger";

// Injectable warn sink (see SlackConversationDispatchDeps.logWarn for why
// tests must inject rather than mock the logger module).
type SlackConversationThreadsDeps = {
  logWarn?: (message: string, fields: Record<string, unknown>) => Promise<void> | void;
};

function resolveLogWarn(deps: SlackConversationThreadsDeps) {
  return deps.logWarn ??
    ((message: string, fields: Record<string, unknown>) => logger.warn(message, fields));
}

export async function lookupSlackConversationThreadOwner(input: {
  workspaceId: string;
  channel: string;
  threadTs: string;
}, deps: SlackConversationThreadsDeps = {}): Promise<string | null> {
  const logWarn = resolveLogWarn(deps);
  const channel = normalizeSlackChannelId(input.channel);
  try {
    const [row] = await getDb()
      .select({ deployedName: slackConversationThreads.deployedName })
      .from(slackConversationThreads)
      .where(
        and(
          eq(slackConversationThreads.workspaceId, input.workspaceId),
          eq(slackConversationThreads.channel, channel),
          eq(slackConversationThreads.threadTs, input.threadTs),
        ),
      )
      .limit(1);
    return row?.deployedName ?? null;
  } catch (error) {
    await logWarn("Slack conversational thread owner lookup failed", {
      area: "integration-watch-dispatch",
      diag: "slack-conversation-thread-owner-lookup-failed",
      workspaceId: input.workspaceId,
      channel,
      threadTs: input.threadTs,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function recordSlackConversationThreadOwner(input: {
  workspaceId: string;
  channel: string;
  threadTs: string;
  deployedName: string;
  agentId: string;
}, deps: SlackConversationThreadsDeps = {}): Promise<void> {
  const logWarn = resolveLogWarn(deps);
  const channel = normalizeSlackChannelId(input.channel);
  try {
    const now = new Date();
    await getDb()
      .insert(slackConversationThreads)
      .values({
        workspaceId: input.workspaceId,
        channel,
        threadTs: input.threadTs,
        deployedName: input.deployedName,
        agentId: input.agentId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          slackConversationThreads.workspaceId,
          slackConversationThreads.channel,
          slackConversationThreads.threadTs,
        ],
        set: {
          deployedName: input.deployedName,
          agentId: input.agentId,
          updatedAt: now,
        },
      });
  } catch (error) {
    await logWarn("Slack conversational thread owner record failed", {
      area: "integration-watch-dispatch",
      diag: "slack-conversation-thread-owner-record-failed",
      workspaceId: input.workspaceId,
      channel,
      threadTs: input.threadTs,
      deployedName: input.deployedName,
      agentId: input.agentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
