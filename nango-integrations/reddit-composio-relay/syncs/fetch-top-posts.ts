import { createSync } from "nango";
import { RedditMetadataSchema, RedditPostsCheckpointSchema } from "./common.js";
import { RedditPostSchema } from "../shared/reddit-record-shapes.js";
import { executeRedditListingPostsSync } from "./fetch-posts-listing.js";

export default createSync({
  description:
    "Sync top posts from tracked subreddits using Composio Reddit retrieval with per-subreddit listing anchors.",
  version: "0.1.0",
  frequency: "every 30 minutes",
  autoStart: false,
  syncType: "incremental",
  endpoints: [{ method: "GET", path: "/reddit/posts/top", group: "Reddit" }],
  metadata: RedditMetadataSchema,
  checkpoint: RedditPostsCheckpointSchema,
  models: {
    RedditTopPost: RedditPostSchema,
  },
  exec: async (nango) =>
    executeRedditListingPostsSync(nango, {
      listing: "top",
      modelName: "RedditTopPost",
      emptyTrackedLogMessage:
        "No tracked subreddits configured in metadata.subreddits; fetch-top-posts will emit zero records.",
    }),
});
