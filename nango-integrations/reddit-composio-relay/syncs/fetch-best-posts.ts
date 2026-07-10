import { createSync } from "nango";
import { RedditMetadataSchema, RedditPostsCheckpointSchema } from "./common.js";
import { RedditPostSchema } from "../shared/reddit-record-shapes.js";
import { executeRedditListingPostsSync } from "./fetch-posts-listing.js";

export default createSync({
  description:
    "Sync best posts from tracked subreddits using Composio Reddit retrieval with per-subreddit listing anchors.",
  version: "0.1.0",
  frequency: "every 30 minutes",
  autoStart: false,
  syncType: "incremental",
  endpoints: [{ method: "GET", path: "/reddit/posts/best", group: "Reddit" }],
  metadata: RedditMetadataSchema,
  checkpoint: RedditPostsCheckpointSchema,
  models: {
    RedditBestPost: RedditPostSchema,
  },
  exec: async (nango) =>
    executeRedditListingPostsSync(nango, {
      listing: "best",
      modelName: "RedditBestPost",
      emptyTrackedLogMessage:
        "No tracked subreddits configured in metadata.subreddits; fetch-best-posts will emit zero records.",
    }),
});
