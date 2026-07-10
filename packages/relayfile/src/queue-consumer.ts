import type { AppEnv } from "./env.js";
import {
  signInternalHmac,
  signRelayWebhookPayload,
} from "./middleware/auth.js";
import { handleGithubTarImportQueue } from "./routes/import.js";
import type {
  WebhookDeliveryQueueMessage,
  WritebackQueueMessage,
} from "./types.js";
import { fetchWorkspaceDOWithBackpressure } from "./workspace-do-backpressure.js";
import { executeProviderWritebackBatch } from "./writeback/provider-executor.js";

type QueueBranch =
  | "envelope"
  | "writeback"
  | "audit"
  | "github-import"
  | "webhook-delivery";

const MAX_RETRIES_PER_BRANCH: Record<QueueBranch, number> = {
  envelope: 5,
  writeback: 3,
  audit: 3,
  "github-import": 3,
  "webhook-delivery": 3,
};

const RETRY_SCHEDULE_PER_BRANCH: Partial<
  Record<
    QueueBranch,
    { baseSeconds: number; capSeconds: number; jitterPct: number }
  >
> = {
  "webhook-delivery": {
    baseSeconds: 10,
    capSeconds: 600,
    jitterPct: 0.2,
  },
};

const WEBHOOK_DELIVERY_TIMEOUT_MS = 5000;

async function handleEnvelopeQueue(
  batch: MessageBatch,
  env: AppEnv["Bindings"],
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      const envelope = msg.body as {
        envelopeId: string;
        workspaceId: string;
        provider: string;
        deliveryId?: string;
        receivedAt?: string;
        headers?: Record<string, string>;
        payload?: Record<string, unknown>;
        correlationId?: string;
      };

      const id = env.WORKSPACE_DO.idFromName(envelope.workspaceId);
      const stub = env.WORKSPACE_DO.get(id);
      const response = await fetchWorkspaceDOWithBackpressure(
        stub,
        new Request("https://workspace-do/internal/process-envelope", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Workspace-Id": envelope.workspaceId,
            "X-Correlation-Id": envelope.correlationId ?? "",
          },
          body: JSON.stringify(envelope),
        }),
        {
          reason: "durable_object_overloaded",
          retryAfterSeconds: positiveInt(
            env.RELAYFILE_DO_RETRY_AFTER_SECONDS,
            5,
          ),
        },
      );

      if (!response.ok) {
        throw new Error(`process-envelope returned ${response.status}`);
      }

      msg.ack();
    } catch {
      msg.retry();
    }
  }
}

async function handleWritebackQueue(
  batch: MessageBatch,
  env: AppEnv["Bindings"],
): Promise<void> {
  const messagesByOpId = new Map<string, Message[]>();
  const tasks = batch.messages.map((msg) => {
    const task = msg.body as WritebackQueueMessage;
    const messages = messagesByOpId.get(task.opId) ?? [];
    messages.push(msg);
    messagesByOpId.set(task.opId, messages);
    return task;
  });
  const results = await executeProviderWritebackBatch(tasks, env);
  for (const result of results) {
    const messages = messagesByOpId.get(result.task.opId);
    const msg = messages?.shift();
    if (!msg) continue;
    if (result.success) {
      msg.ack();
      continue;
    }
    if (msg.attempts >= MAX_RETRIES_PER_BRANCH.writeback) {
      try {
        await acknowledgeWritebackFailure(result.task, env, result.error);
        msg.ack();
        continue;
      } catch {}
    }
    msg.retry();
  }
  for (const messages of messagesByOpId.values()) {
    for (const msg of messages) {
      msg.retry();
    }
  }
}

async function handleAuditQueue(
  batch: MessageBatch,
  env: AppEnv["Bindings"],
): Promise<void> {
  const auditUrl = env.RELAYFILE_AUDIT_URL?.trim();
  if (!auditUrl) {
    for (const msg of batch.messages) {
      msg.ack();
    }
    console.warn("relayfile audit URL is not configured; dropping audit batch");
    return;
  }

  const body = JSON.stringify(batch.messages.map((msg) => msg.body));
  const timestamp = new Date().toISOString();
  const signature = await signInternalHmac(
    timestamp,
    body,
    env.INTERNAL_HMAC_SECRET,
  );
  try {
    const response = await globalThis.fetch(auditUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Relay-Timestamp": timestamp,
        "X-Relay-Signature": signature,
      },
      body,
    });
    if (!response.ok) {
      throw new Error(`audit ingest returned ${response.status}`);
    }
    for (const msg of batch.messages) {
      msg.ack();
    }
  } catch {
    for (const msg of batch.messages) {
      msg.retry();
    }
  }
}

async function handleWebhookDeliveryQueue(
  batch: MessageBatch,
  env: AppEnv["Bindings"],
): Promise<void> {
  for (const msg of batch.messages) {
    const task = msg.body as WebhookDeliveryQueueMessage;
    try {
      await deliverWebhook(task);
      await recordWebhookDeliveryResult(task, env, { success: true });
      await markWebhookDeliveryDelivered(task, env);
      msg.ack();
    } catch (error) {
      const sanitized = sanitizeQueueError(error);
      console.warn("relayfile webhook delivery failed", {
        workspaceId: task.workspaceId,
        subscriptionId: task.subscriptionId,
        eventId: task.event.eventId,
        attempt: msg.attempts,
        error: sanitized,
      });
      if (msg.attempts >= MAX_RETRIES_PER_BRANCH["webhook-delivery"]) {
        try {
          await recordWebhookDeliveryResult(task, env, {
            success: false,
            attemptCount: msg.attempts,
            error: sanitized,
          });
          await deadLetterWebhookDelivery(task, env, msg.attempts, sanitized);
          msg.ack();
          continue;
        } catch {}
      }
      msg.retry({
        delaySeconds: retryDelaySeconds("webhook-delivery", msg.attempts),
      });
    }
  }
}

// At-least-once delivery: the CF Queue retries on non-2xx or timeout.
// Receivers MUST dedupe on the X-Relay-Event-Id header (= eventId).
async function deliverWebhook(
  task: WebhookDeliveryQueueMessage,
): Promise<void> {
  const body = JSON.stringify(task.event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await signRelayWebhookPayload(timestamp, body, task.secret);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    WEBHOOK_DELIVERY_TIMEOUT_MS,
  );
  try {
    const response = await globalThis.fetch(task.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Relay-Timestamp": timestamp,
        "X-Relay-Signature": signature,
        "X-Relay-Event-Id": task.event.eventId,
      },
      body,
      signal: controller.signal,
      redirect: "manual",
    });
    if (response.type === "opaqueredirect" || response.status >= 300) {
      throw new Error(`webhook endpoint returned ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function recordWebhookDeliveryResult(
  task: WebhookDeliveryQueueMessage,
  env: Pick<
    AppEnv["Bindings"],
    "WORKSPACE_DO" | "RELAYFILE_DO_RETRY_AFTER_SECONDS"
  >,
  result:
    | { success: true }
    | { success: false; attemptCount: number; error: string },
): Promise<void> {
  const stub = env.WORKSPACE_DO.get(
    env.WORKSPACE_DO.idFromName(task.workspaceId),
  );
  const response = await fetchWorkspaceDOWithBackpressure(
    stub,
    new Request("https://workspace-do/internal/webhook-delivery-result", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Workspace-Id": task.workspaceId,
        "X-Correlation-Id": task.event.correlationId ?? "",
      },
      body: JSON.stringify({
        workspaceId: task.workspaceId,
        subscriptionId: task.subscriptionId,
        url: task.url,
        event: task.event,
        ...result,
      }),
    }),
    {
      reason: "durable_object_overloaded",
      retryAfterSeconds: positiveInt(env.RELAYFILE_DO_RETRY_AFTER_SECONDS, 5),
    },
  );
  if (!response.ok) {
    throw new Error(`webhook delivery ack returned ${response.status}`);
  }
}

async function deadLetterWebhookDelivery(
  task: WebhookDeliveryQueueMessage,
  env: Pick<AppEnv["Bindings"], "DB">,
  attemptCount: number,
  error: string,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `
      INSERT INTO webhook_delivery_dead_letters (
        delivery_id, workspace_id, subscription_id, event_id, url,
        payload_json, attempt_count, last_error, failed_at, replay_count,
        status, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'dead_lettered', ?)
      ON CONFLICT(delivery_id) DO UPDATE SET
        attempt_count = excluded.attempt_count,
        last_error = excluded.last_error,
        failed_at = excluded.failed_at,
        status = 'dead_lettered',
        updated_at = excluded.updated_at
    `,
  )
    .bind(
      task.deliveryId,
      task.workspaceId,
      task.subscriptionId,
      task.event.eventId,
      task.url,
      JSON.stringify(task),
      attemptCount,
      error,
      now,
      now,
    )
    .run();
}

async function markWebhookDeliveryDelivered(
  task: WebhookDeliveryQueueMessage,
  env: Pick<AppEnv["Bindings"], "DB">,
): Promise<void> {
  await env.DB.prepare(
    `
      UPDATE webhook_delivery_dead_letters
      SET status = 'delivered',
          updated_at = ?
      WHERE workspace_id = ? AND delivery_id = ?
    `,
  )
    .bind(new Date().toISOString(), task.workspaceId, task.deliveryId)
    .run();
}

async function acknowledgeWritebackFailure(
  task: WritebackQueueMessage,
  env: Pick<
    AppEnv["Bindings"],
    "WORKSPACE_DO" | "RELAYFILE_DO_RETRY_AFTER_SECONDS"
  >,
  error: unknown,
): Promise<void> {
  const stub = env.WORKSPACE_DO.get(
    env.WORKSPACE_DO.idFromName(task.workspaceId),
  );
  const response = await fetchWorkspaceDOWithBackpressure(
    stub,
    new Request(
      `https://workspace-do/v1/workspaces/${encodeURIComponent(task.workspaceId)}/writeback/${encodeURIComponent(task.opId)}/ack`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Workspace-Id": task.workspaceId,
          "X-Correlation-Id": task.correlationId ?? "",
        },
        body: JSON.stringify({
          success: false,
          error: sanitizeQueueError(error),
        }),
      },
    ),
    {
      reason: "durable_object_overloaded",
      retryAfterSeconds: positiveInt(env.RELAYFILE_DO_RETRY_AFTER_SECONDS, 5),
    },
  );

  if (!response.ok) {
    throw new Error(`writeback ack returned ${response.status}`);
  }
}

function sanitizeQueueError(error: unknown): string {
  const base =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : String(error);

  return base
    .replace(/authorization\s*:\s*bearer\s+[^\s,;]+/gi, "[REDACTED]")
    .replace(/bearer\s+[A-Za-z0-9._~\-+/=]+/gi, "Bearer [REDACTED]")
    .replace(/nango[-_a-z0-9]*secret[^\s,;]*/gi, "[REDACTED]")
    .replace(/token[=:]\s*[^\s,;]+/gi, "token=[REDACTED]");
}

export default {
  queue(batch: MessageBatch, env: AppEnv["Bindings"]) {
    switch (branchByQueueName(batch.queue)) {
      case "envelope":
        return handleEnvelopeQueue(batch, env);
      case "writeback":
        return handleWritebackQueue(batch, env);
      case "audit":
        return handleAuditQueue(batch, env);
      case "github-import":
        return handleGithubTarImportQueue(batch, env);
      case "webhook-delivery":
        return handleWebhookDeliveryQueue(batch, env);
      default:
        console.error(`Unknown queue: ${batch.queue}`);
    }
  },
};

export function branchByQueueName(queueName: string): QueueBranch | null {
  if (
    queueName === "relayfile-envelopes" ||
    queueName.startsWith("relayfile-envelopes-")
  ) {
    return "envelope";
  }
  if (
    queueName === "relayfile-writeback" ||
    queueName.startsWith("relayfile-writeback-")
  ) {
    return "writeback";
  }
  if (
    queueName === "relayfile-audit" ||
    queueName.startsWith("relayfile-audit-")
  ) {
    return "audit";
  }
  if (
    queueName === "relayfile-github-import" ||
    queueName.startsWith("relayfile-github-import-")
  ) {
    return "github-import";
  }
  if (
    queueName === "relayfile-webhooks" ||
    queueName.startsWith("relayfile-webhooks-")
  ) {
    return "webhook-delivery";
  }
  return null;
}

function retryDelaySeconds(branch: QueueBranch, attempts: number): number {
  const schedule = RETRY_SCHEDULE_PER_BRANCH[branch];
  if (!schedule) {
    return 0;
  }
  const exponent = Math.max(0, attempts - 1);
  const base = Math.min(
    schedule.capSeconds,
    schedule.baseSeconds * 2 ** exponent,
  );
  const jitter = base * schedule.jitterPct;
  const delta = (Math.random() * 2 - 1) * jitter;
  return Math.max(1, Math.round(base + delta));
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
