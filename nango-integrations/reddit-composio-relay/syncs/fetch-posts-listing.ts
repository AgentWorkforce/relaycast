import { z } from "zod";
import { buildPostRecord, RedditPostSchema } from "../shared/reddit-record-shapes.js";
import {
  DEFAULT_POST_LIMIT,
  type RedditListingType,
  getRedditToolContext,
  RedditMetadataSchema,
  RedditPostsCheckpointSchema,
  redditRetrievePosts,
  trackedSubredditsFromMetadata,
} from "./common.js";

const parseCheckpointAnchors = (
  value: string | undefined,
): Record<string, string> => {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const entries = Object.entries(parsed as Record<string, unknown>)
      .filter(
        ([key, checkpoint]) =>
          typeof key === "string" &&
          key.length > 0 &&
          typeof checkpoint === "string" &&
          checkpoint.length > 0,
      )
      .map(([key, checkpoint]) => [key, checkpoint as string] as const);
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
};

export interface ListingSyncExecConfig {
  listing: RedditListingType;
  emptyTrackedLogMessage: string;
  modelName: string;
}

export const executeRedditListingPostsSync = async (
  nango: any,
  config: ListingSyncExecConfig,
): Promise<void> => {
    const metadata = RedditMetadataSchema.parse((await nango.getMetadata()) ?? {});
    const tracked = trackedSubredditsFromMetadata(metadata);
    const ctx = await getRedditToolContext(nango);

    if (tracked.length === 0) {
      await nango.log(config.emptyTrackedLogMessage, { level: "warn" });
      return;
    }

    const parsedCheckpoint = RedditPostsCheckpointSchema.safeParse(await nango.getCheckpoint());
    const priorAnchors = parsedCheckpoint.success
      ? parseCheckpointAnchors(parsedCheckpoint.data.latest_seen_by_subreddit_json)
      : {};
    const nextAnchors: Record<string, string> = {};

    for (const subreddit of tracked) {
      const anchor = priorAnchors[subreddit] ?? null;
      let newestSeenName: string | null = null;
      try {
        const posts = await redditRetrievePosts(nango, ctx, {
          subreddit,
          listing: config.listing,
          limit: Math.min(metadata.maxPostsPerSubreddit ?? DEFAULT_POST_LIMIT, DEFAULT_POST_LIMIT),
        });

        const firstName = posts[0] && typeof posts[0]["name"] === "string" ? String(posts[0]["name"]) : null;
        if (firstName) {
          newestSeenName = firstName;
        }

        const fresh: z.infer<typeof RedditPostSchema>[] = [];
        for (const raw of posts) {
          const name = typeof raw["name"] === "string" ? String(raw["name"]) : null;
          if (anchor && name === anchor) {
            break;
          }
          try {
            fresh.push(buildPostRecord(raw));
          } catch (error) {
            await nango.log(
              `Skipping malformed Reddit ${config.listing} post for r/${subreddit}: ${error instanceof Error ? error.message : String(error)}`,
              { level: "warn" },
            );
          }
        }

        if (fresh.length > 0) {
          await nango.batchSave(fresh, config.modelName);
        }
      } catch (error) {
        await nango.log(
          `Skipping ${config.listing} listing for r/${subreddit}: ${error instanceof Error ? error.message : String(error)}`,
          { level: "warn" },
        );
      }

      if (newestSeenName) {
        nextAnchors[subreddit] = newestSeenName;
      } else if (anchor) {
        nextAnchors[subreddit] = anchor;
      }
    }

    await nango.saveCheckpoint({
      latest_seen_by_subreddit_json: JSON.stringify(nextAnchors),
    });
};
