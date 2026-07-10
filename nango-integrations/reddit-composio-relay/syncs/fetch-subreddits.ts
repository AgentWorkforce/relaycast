import { createSync } from "nango";
import { RedditTrackedSubredditSchema } from "../shared/reddit-record-shapes.js";
import {
  getRedditToolContext,
  RedditMetadataSchema,
  redditRetrievePosts,
  trackedSubredditsFromMetadata,
} from "./common.js";
import { buildTrackedSubredditRecord } from "../shared/reddit-record-shapes.js";

export default createSync({
  description:
    "Sync tracked subreddit metadata from Composio Reddit toolkit based on connection metadata.subreddits.",
  version: "0.1.0",
  frequency: "every 12 hours",
  autoStart: false,
  syncType: "full",
  endpoints: [{ method: "GET", path: "/reddit/subreddits", group: "Reddit" }],
  metadata: RedditMetadataSchema,
  models: {
    RedditTrackedSubreddit: RedditTrackedSubredditSchema,
  },

  exec: async (nango) => {
    const metadata = RedditMetadataSchema.parse((await nango.getMetadata()) ?? {});
    const tracked = trackedSubredditsFromMetadata(metadata);
    const ctx = await getRedditToolContext(nango);

    const activeIds = new Set<string>();
    if (tracked.length === 0) {
      await nango.log(
        "No tracked subreddits configured in metadata.subreddits; sync will emit zero records.",
        { level: "warn" },
      );
    }

    for (const subreddit of tracked) {
      try {
        const posts = await redditRetrievePosts(nango, ctx, { subreddit, limit: 1 });
        const head = posts[0] ?? {};
        const raw: Record<string, unknown> = {
          name: subreddit,
          display_name: subreddit,
          display_name_prefixed: `r/${subreddit}`,
          title: typeof head["subreddit"] === "string" ? String(head["subreddit"]) : subreddit,
          subscribers: typeof head["subreddit_subscribers"] === "number" ? head["subreddit_subscribers"] : undefined,
          over18: typeof head["over_18"] === "boolean" ? head["over_18"] : undefined,
          icon_img: typeof head["thumbnail"] === "string" ? head["thumbnail"] : undefined,
        };
        const record = buildTrackedSubredditRecord(raw);
        activeIds.add(record.id);
        await nango.batchSave([record], "RedditTrackedSubreddit");
      } catch (error) {
        await nango.log(
          `Skipping subreddit ${subreddit}: ${error instanceof Error ? error.message : String(error)}`,
          { level: "warn" },
        );
      }
    }

    const toDelete: Array<{ id: string }> = [];
    for await (const existing of nango.listRecords<{ id: string }>("RedditTrackedSubreddit")) {
      const id = String(existing.id ?? "");
      if (id && !activeIds.has(id)) {
        toDelete.push({ id });
      }
    }

    if (toDelete.length > 0) {
      await nango.batchDelete(toDelete, "RedditTrackedSubreddit");
    }
  },
});
