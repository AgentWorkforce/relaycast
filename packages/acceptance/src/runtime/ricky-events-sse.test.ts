// @route GET /api/v1/ricky/runs/[rickyRunId]/events
import { z } from "zod";
import { describe, it } from "vitest";
import {
  expectJsonError,
  expectSseShape,
  hasBearerAuth,
} from "../helpers/runtime";

const RickyEventsErrorSchema = z.object({
  error: z.string().optional(),
  message: z.string().optional(),
  Reason: z.string().optional(),
}).refine((value) => Boolean(value.error ?? value.message ?? value.Reason));

describe("/api/v1/ricky/runs/[id]/events", () => {
  it("rejects unauthenticated event streaming", async () => {
    const body = await expectJsonError("/api/v1/ricky/runs/test-run/events", {
      headers: { accept: "text/event-stream" },
      allowedStatus: [401, 429],
    });

    RickyEventsErrorSchema.parse(body);
  });

  const sseRunId = process.env.ACCEPTANCE_RICKY_SSE_RUN_ID?.trim();
  (sseRunId && hasBearerAuth() ? it : it.skip)(
    "serves an SSE stream with the expected transport shape",
    async () => {
      await expectSseShape(`/api/v1/ricky/runs/${sseRunId}/events`, {
        auth: "user",
      });
    },
  );
});
