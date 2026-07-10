import { handle as handleNango } from "./handlers/nango";
import { processWebhookQueueBatch } from "./queue-consumer";
import type { Env, LegacyWebhookQueueMessage, WebhookQueueMessage } from "./types";
import {
  buildEvidenceFromHop,
  emitCloudEvidence,
} from "@cloud/core/observability/evidence-emitter.js";
import {
  newRequestId,
  resolveTelemetryMeta,
  type TelemetryMeta,
} from "@cloud/core/observability/telemetry-meta.js";
import { instrumentWorker } from "@cloud/core/observability/worker-otel.js";

const HANDLERS = new Map<
  string,
  (
    request: Request,
    env: Env,
    options: { meta: TelemetryMeta },
  ) => Promise<Response>
>([
  ["/api/v1/webhooks/nango", handleNango],
]);

const handler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const meta = resolveTelemetryMeta(env, "webhook-worker");
    const requestId = newRequestId();
    const pathname = new URL(request.url).pathname;
    const handler = HANDLERS.get(pathname);

    if (!handler) {
      return new Response("Not Found", { status: 404 });
    }

    try {
      const response = await handler(request, env, { meta });
      if (response.status >= 500) {
        emitCloudEvidence(
          env,
          ctx,
          buildEvidenceFromHop(meta, {
            path: "webhook.fetch",
            kind: "request_error",
            outcome: "error",
            severity: 6,
            requestId,
            summary: `webhook-worker fetch failed for ${pathname} (${response.status})`,
            counts: { errors: 1 },
            inspect: {
              logQuery: `area:"nango-webhook-path" AND requestId:"${requestId}"`,
            },
          }),
        );
      }
      return response;
    } catch (error) {
      emitCloudEvidence(
        env,
        ctx,
        buildEvidenceFromHop(meta, {
          path: "webhook.fetch",
          kind: "request_error",
          outcome: "error",
          severity: 6,
          requestId,
          summary: `webhook-worker fetch failed for ${pathname} (throw)`,
          counts: { errors: 1 },
          errorMessage: error instanceof Error ? error.message : String(error),
          inspect: {
            logQuery: `area:"nango-webhook-path" AND requestId:"${requestId}"`,
          },
        }),
      );
      throw error;
    }
  },

  async queue(
    batch: MessageBatch<WebhookQueueMessage | LegacyWebhookQueueMessage>,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    await processWebhookQueueBatch(batch, env, ctx);
  },
};

export default instrumentWorker(handler, { serviceName: "webhook-worker" });
