import { createAction } from "nango";
import { z } from "zod";
import { executeComposioTool, getComposioContext } from "../shared/composio-tool.js";

const InputSchema = z.object({
  thing_id: z.string().min(1),
  text: z.string().min(1),
});

const OutputSchema = z.object({
  success: z.literal(true),
  data: z.record(z.string(), z.unknown()).optional(),
});

export default createAction({
  description: "Post a Reddit comment through Composio Reddit toolkit.",
  version: "0.1.0",
  endpoint: { method: "POST", path: "/reddit/comments", group: "Reddit" },
  input: InputSchema,
  output: OutputSchema,

  exec: async (nango, input) => {
    const ctx = await getComposioContext(nango);
    const data = await executeComposioTool<Record<string, unknown>>(nango, ctx, {
      toolSlug: "REDDIT_POST_REDDIT_COMMENT",
      arguments: {
        thing_id: input.thing_id,
        text: input.text,
      },
      retries: 0,
    });

    return { success: true as const, data };
  },
});
