import type { EnqueueCloudAgentBoxWarmPayload } from "@/app/api/v1/workspaces/[workspaceId]/cloud-agents/[cloudAgentId]/box/warm-job-store";

/**
 * Cloud-agent box warm consumer Worker (issue #1384, slice 3a, option b) — THIN.
 *
 * A dedicated Cloudflare Queue consumer that carries NO heavy imports (no
 * @daytonaio/box-manager/core) — only a type-only import (erased at build) — so
 * it bundles cleanly (the dedicated-Worker-with-daytona attempt #1462 failed on
 * native .node deps). Per message it forwards {jobId,expectedStep} to the
 * cloud-web internal warm-step endpoint over a SERVICE BINDING; cloud-web (which
 * already bundles + runs the daytona warm code) executes the step + re-enqueues.
 * ack on 2xx, retry otherwise (-> DLQ after maxRetries, where the DLQ batch is
 * forwarded with dlq:true so cloud-web marks the job/sandbox failed).
 *
 * DORMANT: receives no messages until CLOUD_AGENT_WARM_VIA_QUEUE flips on.
 */

// cloud-web runs Next with basePath "/cloud" (packages/web/next.config.ts), and
// a SERVICE-BINDING fetch goes straight to the worker script (bypassing the
// public router), so it must carry the "/cloud" prefix itself — a bare
// "/api/v1/..." would 404 in prod (verified: infra/web-worker.ts serves
// /cloud/api/*).
const WARM_STEP_PATH = "/cloud/api/v1/internal/cloud-agent-warm/step";

interface ServiceBinding {
  fetch(request: Request): Promise<Response>;
}
interface QueueMessageLike {
  body: unknown;
  ack(): void;
  retry(): void;
}
interface MessageBatchLike {
  queue: string;
  messages: QueueMessageLike[];
}
interface WarmConsumerEnv {
  CLOUD_WEB: ServiceBinding;
  BROKER_HMAC_SECRET: string;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parsePayload(body: unknown): EnqueueCloudAgentBoxWarmPayload | null {
  const raw = typeof body === "string" ? safeJson(body) : body;
  const p = raw as Partial<EnqueueCloudAgentBoxWarmPayload> | null;
  if (!p || typeof p.jobId !== "string" || typeof p.expectedStep !== "string") {
    return null;
  }
  return { jobId: p.jobId, expectedStep: p.expectedStep };
}

function isDeadLetterQueue(queueName: string): boolean {
  return /dlq/i.test(queueName);
}

export default {
  async queue(batch: MessageBatchLike, env: WarmConsumerEnv): Promise<void> {
    const dlq = isDeadLetterQueue(batch.queue);
    for (const message of batch.messages) {
      const payload = parsePayload(message.body);
      if (!payload) {
        console.error("[cloud-agent-warm] dropping unparseable queue message", {
          area: "cloud-agent-warm",
          queue: batch.queue,
        });
        message.ack();
        continue;
      }
      try {
        const response = await env.CLOUD_WEB.fetch(
          new Request(`https://cloud-web.internal${WARM_STEP_PATH}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${env.BROKER_HMAC_SECRET}`,
            },
            body: JSON.stringify(dlq ? { ...payload, dlq: true } : payload),
          }),
        );
        if (response.ok) {
          message.ack();
        } else {
          console.error("[cloud-agent-warm] cloud-web warm-step non-2xx; retrying", {
            area: "cloud-agent-warm",
            queue: batch.queue,
            jobId: payload.jobId,
            expectedStep: payload.expectedStep,
            status: response.status,
          });
          message.retry();
        }
      } catch (error) {
        console.error("[cloud-agent-warm] warm-step dispatch failed; retrying", {
          area: "cloud-agent-warm",
          queue: batch.queue,
          jobId: payload.jobId,
          expectedStep: payload.expectedStep,
          error: error instanceof Error ? error.message : String(error),
        });
        message.retry();
      }
    }
  },
};
