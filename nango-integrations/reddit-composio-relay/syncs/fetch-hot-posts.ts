import { createSync } from "nango";
import { RedditMetadataSchema, RedditPostsCheckpointSchema } from "./common.js";
import { RedditPostSchema } from "../shared/reddit-record-shapes.js";
import { executeRedditListingPostsSync } from "./fetch-posts-listing.js";

export default createSync({
  description:
    "Sync hot posts from tracked subreddits using Composio Reddit retrieval with per-subreddit listing anchors.",
  version: "0.1.0",
  frequency: "every 30 minutes",
  autoStart: false,
  syncType: "incremental",
  endpoints: [{ method: "GET", path: "/reddit/posts/hot", group: "Reddit" }],
  metadata: RedditMetadataSchema,
  checkpoint: RedditPostsCheckpointSchema,
  models: {
    RedditHotPost: RedditPostSchema,
  },
  exec: async (nango) =>
    executeRedditListingPostsSync(nango, {
      listing: "hot",
      modelName: "RedditHotPost",
      emptyTrackedLogMessage:
        "No tracked subreddits configured in metadata.subreddits; fetch-hot-posts will emit zero records.",
    }),
});
