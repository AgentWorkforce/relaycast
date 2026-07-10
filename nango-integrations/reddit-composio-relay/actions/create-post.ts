import { createAction } from "nango";
import { z } from "zod";
import { executeComposioTool, getComposioContext } from "../shared/composio-tool.js";
import { normalizeSubredditName } from "../shared/reddit-record-shapes.js";

const InputSchema = z.object({
  subreddit: z.string().min(1),
  title: z.string().min(1),
  text: z.string().optional(),
  url: z.string().url().optional(),
  kind: z.enum(["self", "link"]).optional(),
  flair_id: z.string().optional(),
  nsfw: z.boolean().optional(),
  spoiler: z.boolean().optional(),
});

const OutputSchema = z.object({
  success: z.literal(true),
  data: z.record(z.string(), z.unknown()).optional(),
});

export default createAction({
  description: "Create a Reddit post through Composio Reddit toolkit.",
  version: "0.1.0",
  endpoint: { method: "POST", path: "/reddit/posts", group: "Reddit" },
  input: InputSchema,
  output: OutputSchema,

  exec: async (nango, input) => {
    const ctx = await getComposioContext(nango);
    const kind = input.kind ?? (input.url ? "link" : "self");
    const payload: Record<string, unknown> = {
      subreddit: normalizeSubredditName(input.subreddit),
      title: input.title,
      kind,
      flair_id: input.flair_id ?? "",
      ...(kind === "self" ? { text: input.text ?? "" } : {}),
      ...(kind === "link" && input.url ? { url: input.url } : {}),
      ...(input.nsfw !== undefined ? { nsfw: input.nsfw } : {}),
      ...(input.spoiler !== undefined ? { spoiler: input.spoiler } : {}),
    };

    const data = await executeComposioTool<Record<string, unknown>>(nango, ctx, {
      toolSlug: "REDDIT_CREATE_REDDIT_POST",
      arguments: payload,
      retries: 0,
    });

    return { success: true as const, data };
  },
});
