import { and, eq } from "drizzle-orm";
import { getDb, type AppDb } from "@/lib/db";
import {
  slackRelayLinks,
  slackRelayMessages,
} from "@/lib/db/schema";
import type {
  SlackRelayDirection,
  SlackRelayLink,
  SlackRelayStore,
} from "./types";

export interface CreateSlackRelayLinkInput {
  workspaceId: string;
  slackChannelId: string;
  relayChannelId: string;
  createdBy?: string | null;
}

function mapLink(row: typeof slackRelayLinks.$inferSelect): SlackRelayLink {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    slackChannelId: row.slackChannelId,
    relayChannelId: row.relayChannelId,
  };
}

export function createSlackRelayBridgeStore(db: AppDb = getDb()): SlackRelayStore & {
  createOrGetLink(input: CreateSlackRelayLinkInput): Promise<SlackRelayLink>;
} {
  return {
    async createOrGetLink(input) {
      const values = {
        workspaceId: input.workspaceId,
        slackChannelId: input.slackChannelId,
        relayChannelId: input.relayChannelId,
        createdBy: input.createdBy ?? null,
        updatedAt: new Date(),
      };
      const [inserted] = await db
        .insert(slackRelayLinks)
        .values(values)
        .onConflictDoUpdate({
          target: [
            slackRelayLinks.workspaceId,
            slackRelayLinks.slackChannelId,
            slackRelayLinks.relayChannelId,
          ],
          set: { updatedAt: new Date() },
        })
        .returning();

      return mapLink(inserted);
    },

    async findLink(workspaceId, slackChannelId) {
      const [row] = await db
        .select()
        .from(slackRelayLinks)
        .where(
          and(
            eq(slackRelayLinks.workspaceId, workspaceId),
            eq(slackRelayLinks.slackChannelId, slackChannelId),
          ),
        )
        .limit(1);

      return row ? mapLink(row) : null;
    },

    async findMapping(input: {
      linkId: string;
      slackTs: string;
      direction: SlackRelayDirection;
    }) {
      const [row] = await db
        .select({ relayMessageId: slackRelayMessages.relayMessageId })
        .from(slackRelayMessages)
        .where(
          and(
            eq(slackRelayMessages.linkId, input.linkId),
            eq(slackRelayMessages.slackTs, input.slackTs),
            eq(slackRelayMessages.direction, input.direction),
          ),
        )
        .limit(1);

      return row ?? null;
    },

    async recordMapping(input) {
      const rows = await db
        .insert(slackRelayMessages)
        .values(input)
        .onConflictDoNothing({
          target: [
            slackRelayMessages.linkId,
            slackRelayMessages.slackTs,
            slackRelayMessages.direction,
          ],
        })
        .returning({ relayMessageId: slackRelayMessages.relayMessageId });

      return { inserted: rows.length > 0 };
    },
  };
}
