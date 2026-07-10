import { createAction } from "nango";
import { z } from "zod";
import { executeComposioTool, getComposioContext } from "../shared/composio-tool.js";

const InputSchema = z.object({
  id: z.string().min(1),
});

const OutputSchema = z.object({
  success: z.literal(true),
  data: z.record(z.string(), z.unknown()).optional(),
});

export default createAction({
  description: "Delete a Reddit post through Composio Reddit toolkit.",
  version: "0.1.0",
  endpoint: { method: "DELETE", path: "/reddit/posts", group: "Reddit" },
  input: InputSchema,
  output: OutputSchema,

  exec: async (nango, input) => {
    const ctx = await getComposioContext(nango);
    const data = await executeComposioTool<Record<string, unknown>>(nango, ctx, {
      toolSlug: "REDDIT_DELETE_REDDIT_POST",
      arguments: {
        id: input.id,
      },
      retries: 0,
    });

    return { success: true as const, data };
  },
});
