import { z } from "zod";
import type { NangoSync } from "nango";
import { normalizeSubredditName } from "../shared/reddit-record-shapes.js";
import {
  executeComposioTool,
  getComposioContext,
  type ComposioContext,
} from "../shared/composio-tool.js";

export const RedditMetadataSchema = z
  .object({
    subreddits: z.array(z.string()).optional(),
    subredditNames: z.array(z.string()).optional(),
    maxPostsPerSubreddit: z.number().int().positive().max(500).optional(),
  })
  .passthrough();

export const RedditPostsCheckpointSchema = z.object({
  latest_seen_by_subreddit_json: z.string(),
});

export const DEFAULT_POST_LIMIT = 100;
export const DEFAULT_TRACKED_SUBREDDITS = ["tech", "claudecode", "ai_agents"] as const;
export type RedditListingType = "new" | "hot" | "rising" | "top" | "best";

export const trackedSubredditsFromMetadata = (metadata: z.infer<typeof RedditMetadataSchema>): string[] => {
  const names = [
    ...(metadata.subreddits ?? []),
    ...(metadata.subredditNames ?? []),
  ]
    .map(normalizeSubredditName)
    .filter(Boolean);

  const unique = Array.from(new Set(names));
  return unique.length > 0 ? unique : [...DEFAULT_TRACKED_SUBREDDITS];
};

export const getRedditToolContext = async (nango: NangoSync): Promise<ComposioContext> =>
  getComposioContext(nango);

interface ComposioRedditRetrievePostsResponse {
  posts_list?: Array<Record<string, unknown>>;
}

const unwrapRetrievedPost = (value: Record<string, unknown>): Record<string, unknown> => {
  const nested = value["data"];
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  return value;
};

export async function redditRetrievePosts(
  nango: NangoSync,
  ctx: ComposioContext,
  input: {
    subreddit: string;
    limit?: number;
    listing?: RedditListingType;
  },
): Promise<Array<Record<string, unknown>>> {
  const size = Math.max(1, Math.min(input.limit ?? DEFAULT_POST_LIMIT, 100));
  const normalizedSubreddit = normalizeSubredditName(input.subreddit);
  const listing = input.listing ?? "new";
  const subredditPath = listing === "new" ? normalizedSubreddit : `${normalizedSubreddit}/${listing}`;
  const response = await executeComposioTool<ComposioRedditRetrievePostsResponse>(nango, ctx, {
    toolSlug: "REDDIT_RETRIEVE_REDDIT_POST",
    arguments: {
      subreddit: subredditPath,
      size,
    },
    retries: 2,
  });
  return (response.posts_list ?? [])
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map(unwrapRetrievedPost);
}
