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
  description: "Edit a Reddit post body through Composio Reddit toolkit.",
  version: "0.1.0",
  endpoint: { method: "PATCH", path: "/reddit/posts", group: "Reddit" },
  input: InputSchema,
  output: OutputSchema,

  exec: async (nango, input) => {
    const ctx = await getComposioContext(nango);
    const data = await executeComposioTool<Record<string, unknown>>(nango, ctx, {
      toolSlug: "REDDIT_EDIT_REDDIT_COMMENT_OR_POST",
      arguments: {
        thing_id: input.thing_id,
        text: input.text,
      },
      retries: 0,
    });

    return { success: true as const, data };
  },
});
