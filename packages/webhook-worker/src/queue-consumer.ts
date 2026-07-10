import type {
  Env,
  GitLabHookdeckQueueMessage,
  LegacyWebhookQueueMessage,
  NangoSyncQueueMessage,
  WebhookPayloadRef,
  WebhookQueueMessage,
} from "./types";
import {
  buildDedupeInput,
  withWebhookDedup,
  type NangoSyncDedupStore,
} from "./dedup";
import { logHop } from "@cloud/core/observability/structured-log.js";
import {
  buildEvidenceFromHop,
  emitCloudEvidence,
} from "@cloud/core/observability/evidence-emitter.js";
import {
  resolveTelemetryMeta,
  type TelemetryMeta,
} from "@cloud/core/observability/telemetry-meta.js";
import { D1NangoSyncDedupStore } from "./d1-dedup";

const RETRY_DELAY_SECONDS = 60;
const CLOUD_WEB_FORWARD_TIMEOUT_MS = 15_000;
const WEBHOOK_PAYLOAD_READ_TIMEOUT_MS = 15_000;
const CLOUD_WEB_RESPONSE_TEXT_TIMEOUT_MS = 5_000;
const WEBHOOK_QUEUE_BATCH_CONCURRENCY = 10;
const PROVIDER_NOT_PARITY_ENABLED = "provider_not_parity_enabled";
const defaultDedupStores = new WeakMap<D1Database, NangoSyncDedupStore>();
const FORWARDED_BY_HEADER = "x-cloud-webhook-worker-forwarded";
const FORWARDED_REQUEST_ID_HEADER = "x-cloud-webhook-worker-request-id";
const HOP_BY_HOP_FORWARD_HEADER_NAMES = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const NANGO_SIGNATURE_FORWARD_HEADER_NAMES = new Set([
  "x-nango-hmac-sha256",
  "x-nango-signature",
]);

type QueueMessage = Message<WebhookQueueMessage | LegacyWebhookQueueMessage>;
type DedupableWebhookQueueMessage = NangoSyncQueueMessage | GitLabHookdeckQueueMessage;
export type QueueDisposition = "ack" | "retry";

/**
 * Processor seam for the v2 queue-consumer.
 *
 * The default consumer behaviour forwards the original signed webhook body to
 * cloud-web once the shared router `WEBHOOK_ORIGIN` flag is flipped to
 * `worker`. A caller may inject a `processor` to drive alternative work — this
 * is the seam B1 provider parity (and the B2 DLQ-replay proof harness in
 * `test/dlq-replay.test.ts`) use to exercise real end-to-end behaviour.
 *
 * The processor is invoked AFTER the dedup claim is granted, so a `"ack"`
 * disposition triggers `complete(...)` on the dedup store and a thrown error
 * / `"retry"` triggers `fail(...)`. A subsequent redelivery of the same
 * logical message therefore observes `duplicate_completed` and ACKs without
 * re-executing the processor, which is the at-least-once → exactly-once
 * contract the dedup table enforces.
 */
export type WebhookProcessor = (
  message: QueueMessage,
  body: WebhookQueueMessage,
) => Promise<QueueDisposition>;

export type QueueConsumerOptions = {
  dedupStore?: NangoSyncDedupStore;
  processor?: WebhookProcessor;
  telemetryMeta?: TelemetryMeta;
};

type QueueFailure = {
  code: string;
  message: string;
};

class WebhookPayloadReadError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = "WebhookPayloadReadError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isV2Message(body: unknown): body is WebhookQueueMessage {
  return isRecord(body) && body.version === 2;
}

function failureForV2Message(body: WebhookQueueMessage): QueueFailure {
  if (body.ingress === "integration-watch-delivery-drain") {
    return {
      code: "integration_watch_drain_cloud_route_not_configured",
      message: "Integration watch delivery drain consumer requires CLOUD_WEB_WEBHOOK_ORIGIN",
    };
  }

  if (body.ingress === "nango-sync") {
    return {
      code: PROVIDER_NOT_PARITY_ENABLED,
      message: "Nango sync consumer parity is not enabled in B1-PR1",
    };
  }

  if (body.ingress === "nango-forward") {
    return {
      code: "nango_forward_cloud_route_not_configured",
      message: "Nango forward consumer requires CLOUD_WEB_WEBHOOK_ORIGIN",
    };
  }

  if (body.ingress === "gitlab-hookdeck") {
    return {
      code: "gitlab_hookdeck_resolution_not_implemented",
      message: "GitLab Hookdeck consumer resolution is not implemented in B1-PR1",
    };
  }

  return {
    code: PROVIDER_NOT_PARITY_ENABLED,
    message: "Generic provider consumer parity is not enabled in B1-PR1",
  };
}

function logQueueEvent(
  level: "info" | "warn",
  label: string,
  body: WebhookQueueMessage | LegacyWebhookQueueMessage | null | undefined,
  messageId: string,
  extra: Record<string, unknown> = {},
): void {
  console[level](`[webhook-worker/queue] ${label}`, {
    area: "webhook-worker-queue",
    provider: body?.provider,
    ingress: body && isV2Message(body) ? body.ingress : "legacy",
    requestId: body?.requestId,
    messageId,
    ...extra,
  });
}

function isDedupableV2Message(body: WebhookQueueMessage): body is DedupableWebhookQueueMessage {
  return body.ingress === "nango-sync" || body.ingress === "gitlab-hookdeck";
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function webhookPathForMessage(body: WebhookQueueMessage): string {
  if (body.ingress === "integration-watch-delivery-drain") {
    return "internal/proactive-runtime/integration-watch-deliveries/drain";
  }

  if (body.ingress === "gitlab-hookdeck") {
    return "hookdeck";
  }

  if (body.ingress === "nango-forward" || body.ingress === "nango-sync") {
    return "nango";
  }

  return body.provider;
}

function buildCloudWebhookUrl(origin: string, body: WebhookQueueMessage): string {
  const url = new URL(origin);
  const basePath = trimTrailingSlash(url.pathname);
  const cloudPrefix = basePath.endsWith("/cloud")
    ? basePath
    : `${basePath}/cloud`;
  url.pathname = body.ingress === "integration-watch-delivery-drain"
    ? `${cloudPrefix}/api/${webhookPathForMessage(body)}`
    : `${cloudPrefix}/api/v1/webhooks/${webhookPathForMessage(body)}`;
  url.search = "";
  return url.toString();
}

function buildForwardHeaders(body: WebhookQueueMessage, env: Env): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(body.headers)) {
    const normalizedName = name.toLowerCase();
    if (HOP_BY_HOP_FORWARD_HEADER_NAMES.has(normalizedName)) {
      continue;
    }
    if (
      body.ingress === "gitlab-hookdeck" &&
      NANGO_SIGNATURE_FORWARD_HEADER_NAMES.has(normalizedName)
    ) {
      continue;
    }
    headers.set(name, value);
  }
  if (body.ingress === "integration-watch-delivery-drain") {
    const secret = env.AGENT_GATEWAY_INTERNAL_SECRET?.trim();
    if (secret) {
      headers.set("x-agent-gateway-secret", secret);
    } else {
      console.warn(
        "[webhook-worker] AGENT_GATEWAY_INTERNAL_SECRET is not configured; integration-watch drain forward will fail with 401",
      );
    }
  }
  headers.set(FORWARDED_BY_HEADER, "webhook-worker");
  headers.set(FORWARDED_REQUEST_ID_HEADER, body.requestId);
  return headers;
}

function isPermanentForwardRejection(status: number): boolean {
  return status === 400 || status === 422;
}

function isAbortLikeError(error: unknown): boolean {
  return error instanceof DOMException && (
    error.name === "AbortError" ||
    error.name === "TimeoutError"
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: (error: DOMException) => void,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new DOMException(`${label} timed out after ${timeoutMs}ms`, "TimeoutError");
      onTimeout?.(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function abortSignalError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortSignalError(signal);
  }
}

async function readStreamText(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  const cancelReader = () => {
    void reader.cancel(signal ? abortSignalError(signal) : undefined).catch(() => {});
  };

  signal?.addEventListener("abort", cancelReader, { once: true });
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        chunks.push(value);
        totalLength += value.byteLength;
      }
    }
  } catch (error) {
    if (signal?.aborted) {
      throw abortSignalError(signal);
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    try {
      reader.releaseLock();
    } catch {
      // The stream may already be canceled on timeout.
    }
  }

  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function elapsedMs(startedAt: number): number {
  return Date.now() - startedAt;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function readWebhookPayload(
  env: Env,
  payload: WebhookPayloadRef,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  if (payload.storage === "inline") {
    return payload.body;
  }

  if (!env.WEBHOOK_PAYLOADS) {
    throw new WebhookPayloadReadError(
      "WEBHOOK_PAYLOADS binding is required to read queued webhook payload",
      "webhook_payloads_binding_missing",
      false,
    );
  }

  const object = await env.WEBHOOK_PAYLOADS.get(payload.key);
  throwIfAborted(signal);
  if (!object) {
    throw new WebhookPayloadReadError(
      `Queued webhook payload missing from R2: ${payload.key}`,
      "queued_payload_missing_from_r2",
      true,
    );
  }

  const body = object.body
    ? await readStreamText(object.body, signal)
    : await object.text();
  throwIfAborted(signal);
  const actualSha = await sha256Hex(body);
  if (actualSha !== payload.sha256) {
    throw new WebhookPayloadReadError(
      `Queued webhook payload sha256 mismatch for ${payload.key}`,
      "queued_payload_sha256_mismatch",
      true,
    );
  }
  return body;
}

function hasRecordField(body: Record<string, unknown>, field: string): boolean {
  return isRecord(body[field]);
}

function isMalformedDedupableV2Message(body: WebhookQueueMessage): boolean {
  if (body.ingress === "nango-sync") {
    return !hasRecordField(body, "payload") ||
      !hasRecordField(body, "nango") ||
      !hasRecordField(body, "dedupe");
  }

  if (body.ingress === "gitlab-hookdeck") {
    return !hasRecordField(body, "payload") ||
      !hasRecordField(body, "gitlab") ||
      !hasRecordField(body, "hookdeck") ||
      !hasRecordField(body, "dedupe");
  }

  return false;
}

type BatchProcessingLane = {
  key: string;
  messages: Message<WebhookQueueMessage | LegacyWebhookQueueMessage>[];
};

function batchLaneKeyForMessage(
  message: Message<WebhookQueueMessage | LegacyWebhookQueueMessage>,
  index: number,
): string {
  const body = message.body;
  if (body && isV2Message(body) && isDedupableV2Message(body) && !isMalformedDedupableV2Message(body)) {
    const dedupeInput = buildDedupeInput(body);
    if (dedupeInput) {
      return `dedupe:${dedupeInput.surface}:${dedupeInput.dedupeId}`;
    }
  }

  return `message:${index}:${message.id}`;
}

function buildBatchProcessingLanes(
  messages: readonly Message<WebhookQueueMessage | LegacyWebhookQueueMessage>[],
): BatchProcessingLane[] {
  const lanes: BatchProcessingLane[] = [];
  const lanesByKey = new Map<string, BatchProcessingLane>();

  messages.forEach((message, index) => {
    const key = batchLaneKeyForMessage(message, index);
    let lane = lanesByKey.get(key);
    if (!lane) {
      lane = { key, messages: [] };
      lanesByKey.set(key, lane);
      lanes.push(lane);
    }
    lane.messages.push(message);
  });

  return lanes;
}

// The webhook-worker is deployed exclusively to Cloudflare Workers
// (packages/webhook-worker/src/index.ts -> infra/webhook-worker.ts), where
// Postgres (the `pg` client / Node `net`/`dns`/`fs`) cannot run. The
// production default is therefore D1: it gives the queue consumer durable,
// atomic claim/complete/fail rows for at-least-once redelivery suppression
// without pulling Node-only database clients into the Worker bundle. A
// Node/Hyperdrive-capable caller can still inject the Postgres-backed
// `PostgresNangoSyncDedupStore` (from
// `@cloud/core/sync/nango-sync-dedup-postgres.js`) via `options.dedupStore`.
function createDefaultDedupStore(env: Env): NangoSyncDedupStore {
  if (!env.NANGO_SYNC_DEDUP) {
    throw new Error("NANGO_SYNC_DEDUP D1 binding is required for webhook queue dedup");
  }

  let store = defaultDedupStores.get(env.NANGO_SYNC_DEDUP);
  if (!store) {
    store = new D1NangoSyncDedupStore(env.NANGO_SYNC_DEDUP);
    defaultDedupStores.set(env.NANGO_SYNC_DEDUP, store);
  }
  return store;
}

function readDedupStore(env: Env, options: QueueConsumerOptions): NangoSyncDedupStore {
  return options.dedupStore ?? createDefaultDedupStore(env);
}

async function retryV2Message(
  message: QueueMessage,
  body: WebhookQueueMessage,
  failureOverride?: QueueFailure,
): Promise<QueueDisposition> {
  const failure = failureOverride ?? failureForV2Message(body);
  logQueueEvent("warn", "consumer_not_ready", body, message.id, {
    disposition: "retry",
    errorCode: failure.code,
    errorMessage: failure.message,
    attempts: message.attempts,
  });
  message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
  return "retry";
}

async function forwardV2MessageToCloudWeb(
  message: QueueMessage,
  body: WebhookQueueMessage,
  env: Env,
): Promise<QueueDisposition> {
  if (body.ingress === "provider-webhook") {
    return retryV2Message(message, body, {
      code: "provider_webhook_cloud_route_not_configured",
      message: `No cloud-web webhook route is configured for provider ${body.provider}`,
    });
  }

  const origin = env.CLOUD_WEB_WEBHOOK_ORIGIN?.trim();
  if (!origin) {
    return retryV2Message(message, body);
  }

  const totalStartedAt = Date.now();
  const payloadReadStartedAt = Date.now();
  let rawBody: string;
  let payloadReadDurationMs: number;
  const payloadReadAbortController = new AbortController();
  try {
    rawBody = await withTimeout(
      readWebhookPayload(env, body.payload, payloadReadAbortController.signal),
      WEBHOOK_PAYLOAD_READ_TIMEOUT_MS,
      "webhook payload read",
      (error) => payloadReadAbortController.abort(error),
    );
    payloadReadDurationMs = elapsedMs(payloadReadStartedAt);
    logQueueEvent("info", "cloud_web_payload_read", body, message.id, {
      durationMs: payloadReadDurationMs,
      payloadStorage: body.payload.storage,
      payloadSizeBytes: body.payload.sizeBytes,
    });
  } catch (error) {
    logQueueEvent("warn", "cloud_web_payload_read_error", body, message.id, {
      disposition: "retry",
      attempts: message.attempts,
      durationMs: elapsedMs(payloadReadStartedAt),
      timeoutMs: isAbortLikeError(error) ? WEBHOOK_PAYLOAD_READ_TIMEOUT_MS : undefined,
      payloadStorage: body.payload.storage,
      payloadSizeBytes: body.payload.sizeBytes,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  const url = buildCloudWebhookUrl(origin, body);
  let response: Response;
  const fetchStartedAt = Date.now();
  try {
    response = await globalThis.fetch(url, {
      method: "POST",
      headers: buildForwardHeaders(body, env),
      body: rawBody,
      signal: AbortSignal.timeout(CLOUD_WEB_FORWARD_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = isAbortLikeError(error);
    logQueueEvent("warn", timedOut ? "cloud_web_forward_timeout" : "cloud_web_forward_network_error", body, message.id, {
      disposition: "retry",
      attempts: message.attempts,
      durationMs: elapsedMs(fetchStartedAt),
      payloadReadDurationMs,
      totalDurationMs: elapsedMs(totalStartedAt),
      timeoutMs: timedOut ? CLOUD_WEB_FORWARD_TIMEOUT_MS : undefined,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
    return "retry";
  }

  if (response.ok) {
    logQueueEvent("info", "cloud_web_forward_accepted", body, message.id, {
      disposition: "ack",
      status: response.status,
      durationMs: elapsedMs(fetchStartedAt),
      payloadReadDurationMs,
      totalDurationMs: elapsedMs(totalStartedAt),
    });
    return "ack";
  }

  const responseTextStartedAt = Date.now();
  const responseText = await withTimeout(
    response.text(),
    CLOUD_WEB_RESPONSE_TEXT_TIMEOUT_MS,
    "cloud-web response body read",
    (error) => {
      void response.body?.cancel(error).catch(() => {});
    },
  ).catch(() => "");
  const responseTextReadDurationMs = elapsedMs(responseTextStartedAt);
  if (isPermanentForwardRejection(response.status)) {
    logQueueEvent("warn", "cloud_web_forward_permanent_rejection", body, message.id, {
      disposition: "ack",
      attempts: message.attempts,
      status: response.status,
      durationMs: elapsedMs(fetchStartedAt),
      payloadReadDurationMs,
      responseTextReadDurationMs,
      totalDurationMs: elapsedMs(totalStartedAt),
      responseText: responseText.slice(0, 500),
    });
    return "ack";
  }

  logQueueEvent("warn", "cloud_web_forward_rejected", body, message.id, {
    disposition: "retry",
    attempts: message.attempts,
    status: response.status,
    durationMs: elapsedMs(fetchStartedAt),
    payloadReadDurationMs,
    responseTextReadDurationMs,
    totalDurationMs: elapsedMs(totalStartedAt),
    responseText: responseText.slice(0, 500),
  });
  message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
  return "retry";
}

export async function processWebhookQueueMessage(
  message: QueueMessage,
  env: Env,
  ctx: ExecutionContext,
  options: QueueConsumerOptions = {},
): Promise<void> {
  const meta = options.telemetryMeta ?? resolveTelemetryMeta(env, "webhook-worker");
  const body = message.body;

  if (!body || !isV2Message(body)) {
    logQueueEvent("info", "legacy_unprocessable", body, message.id, {
      disposition: "ack",
    });
    logHop({
      hop: "consume",
      outcome: "skip",
      meta,
      messageId: message.id,
      note: "legacy_unprocessable",
      disposition: "ack",
    });
    message.ack();
    return;
  }

  if (isDedupableV2Message(body) && isMalformedDedupableV2Message(body)) {
    logQueueEvent("info", "malformed_v2_unprocessable", body, message.id, {
      disposition: "ack",
    });
    logHop({
      hop: "consume",
      outcome: "skip",
      meta,
      requestId: body.requestId,
      messageId: message.id,
      provider: body.provider,
      note: "malformed_v2_unprocessable",
      disposition: "ack",
    });
    message.ack();
    return;
  }

  const hasInjectedProcessor = Boolean(options.processor);
  const processor: WebhookProcessor =
    options.processor ?? ((m, b) => forwardV2MessageToCloudWeb(m, b, env));
  const dedupeInput = isDedupableV2Message(body) ? buildDedupeInput(body) : null;

  // Per-hop consume log: surfaced before any downstream behavior so a queue
  // trace shows the full provider/sync/model + dedupeId at the consumer
  // boundary. Additive only — does not change ack/retry control flow.
  logHop({
    hop: "consume",
    outcome: "ok",
    meta,
    requestId: body.requestId,
    messageId: message.id,
    provider: body.provider,
    dedupeId: dedupeInput?.dedupeId,
    connectionId: dedupeInput?.connectionId,
    providerConfigKey: dedupeInput?.providerConfigKey,
    syncName: dedupeInput?.syncName,
    model: dedupeInput?.model,
    note: body.ingress,
  });

  if (isDedupableV2Message(body) && dedupeInput) {
    let duplicateCompleted = false;
    try {
      const disposition = await withWebhookDedup(body, () => processor(message, body), {
        store: readDedupStore(env, options),
        shouldComplete: (disposition) => disposition === "ack",
        onDuplicateCompleted: async () => {
          duplicateCompleted = true;
          logQueueEvent("info", "dedup_duplicate_completed", body, message.id, {
            disposition: "ack",
          });
          logHop({
            hop: "dedup",
            outcome: "duplicate",
            meta,
            requestId: body.requestId,
            messageId: message.id,
            provider: body.provider,
            dedupeId: dedupeInput.dedupeId,
            connectionId: dedupeInput.connectionId,
            providerConfigKey: dedupeInput.providerConfigKey,
            syncName: dedupeInput.syncName,
            model: dedupeInput.model,
            note: "completed",
            disposition: "ack",
          });
          return "ack";
        },
        onDuplicateInFlight: async (claim) => {
          logQueueEvent("info", "dedup_duplicate_in_flight", body, message.id, {
            disposition: "retry",
            leaseExpiresAt: claim.leaseExpiresAt?.toISOString(),
          });
          logHop({
            hop: "dedup",
            outcome: "duplicate",
            meta,
            requestId: body.requestId,
            messageId: message.id,
            provider: body.provider,
            dedupeId: dedupeInput.dedupeId,
            connectionId: dedupeInput.connectionId,
            providerConfigKey: dedupeInput.providerConfigKey,
            syncName: dedupeInput.syncName,
            model: dedupeInput.model,
            note: "in_flight",
            disposition: "retry",
          });
          message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
          return "retry";
        },
      });
      if (disposition === "ack" && (!hasInjectedProcessor || duplicateCompleted)) {
        message.ack();
      }
    } catch (error) {
      // Surface the underlying dedup store failure (drizzle/PG) end-to-end.
      // Behavior unchanged: we still rethrow so Cloudflare Queues retries
      // the batch per its existing retry/DLQ semantics. The added log is
      // observability-only.
      logHop({
        hop: "dedup",
        outcome: "error",
        meta,
        requestId: body.requestId,
        messageId: message.id,
        provider: body.provider,
        dedupeId: dedupeInput.dedupeId,
        connectionId: dedupeInput.connectionId,
        providerConfigKey: dedupeInput.providerConfigKey,
        syncName: dedupeInput.syncName,
        model: dedupeInput.model,
        note: "withWebhookDedup",
        error,
      });
      throw error;
    }
    return;
  }

  const disposition = await processor(message, body);
  if (disposition === "ack" && !hasInjectedProcessor) {
    message.ack();
  }
}

function isWebhookEventsDlq(queueName: string | undefined): boolean {
  return queueName?.startsWith("webhook-events-dlq") ?? false;
}

export async function processWebhookDlqBatch(
  batch: MessageBatch<WebhookQueueMessage | LegacyWebhookQueueMessage>,
  env: Env,
  ctx: ExecutionContext,
  meta = resolveTelemetryMeta(env, "webhook-worker"),
): Promise<void> {
  console.warn("[webhook-worker/dlq] webhook_events_dlq_batch", {
    area: "webhook-worker-dlq",
    queue: batch.queue,
    messageCount: batch.messages.length,
  });

  for (const message of batch.messages) {
    const body = message.body;
    const v2 = isV2Message(body);
    console.warn("[webhook-worker/dlq] webhook_events_dlq_dead_letter", {
      area: "webhook-worker-dlq",
      queue: batch.queue,
      messageId: message.id,
      attempts: message.attempts,
      provider: body?.provider,
      ingress: v2 ? body.ingress : "legacy",
      requestId: body?.requestId,
      receivedAt: body?.receivedAt,
    });
    message.ack();
  }

  const first = batch.messages[0]?.body;
  const provider: string = first?.provider ?? "unknown";
  const requestId = first?.requestId;
  const firstV2 = isV2Message(first);
  emitCloudEvidence(
    env,
    ctx,
    buildEvidenceFromHop(meta, {
      path: "webhook.queue.dlq",
      kind: "dlq_dead_letter",
      outcome: "dlq",
      severity: 8,
      requestId,
      correlationIds: {
        ...(batch.messages[0]?.id ? { messageId: batch.messages[0].id } : {}),
        ...(provider !== "unknown" ? { provider } : {}),
        ...(firstV2 ? { ingress: first.ingress } : {}),
      },
      summary: `${batch.messages.length} webhook message(s) dead-lettered on ${batch.queue} (provider=${provider})`,
      counts: {
        messages: batch.messages.length,
        errors: batch.messages.length,
      },
      inspect: {
        dlqQueue: batch.queue,
      },
    }),
  );
}

export async function processWebhookQueueBatch(
  batch: MessageBatch<WebhookQueueMessage | LegacyWebhookQueueMessage>,
  env: Env,
  ctx: ExecutionContext,
  options: QueueConsumerOptions = {},
): Promise<void> {
  const meta = options.telemetryMeta ?? resolveTelemetryMeta(env, "webhook-worker");
  if (isWebhookEventsDlq(batch.queue)) {
    await processWebhookDlqBatch(batch, env, ctx, meta);
    return;
  }

  const batchStartedAt = Date.now();
  const lanes = buildBatchProcessingLanes(batch.messages);
  const concurrency = Math.min(
    WEBHOOK_QUEUE_BATCH_CONCURRENCY,
    Math.max(1, lanes.length),
  );
  logQueueEvent("info", "batch_processing_started", null, "batch", {
    queue: batch.queue,
    messageCount: batch.messages.length,
    laneCount: lanes.length,
    concurrency,
  });

  async function processOne(
    message: Message<WebhookQueueMessage | LegacyWebhookQueueMessage>,
  ): Promise<void> {
    const messageStartedAt = Date.now();
    try {
      await processWebhookQueueMessage(message, env, ctx, {
        ...options,
        telemetryMeta: meta,
      });
      logQueueEvent("info", "message_processing_completed", message.body, message.id, {
        queue: batch.queue,
        durationMs: elapsedMs(messageStartedAt),
      });
    } catch (error) {
      const body = message.body;
      const permanentPayloadFailure =
        error instanceof WebhookPayloadReadError && error.permanent;
      const disposition = permanentPayloadFailure ? "ack" : "retry";
      const errorCode = error instanceof WebhookPayloadReadError
        ? error.code
        : "queue_message_processing_error";
      const errorMessage = error instanceof Error ? error.message : String(error);

      logQueueEvent("warn", "message_processing_error", isV2Message(body) ? body : body, message.id, {
        disposition,
        attempts: message.attempts,
        errorCode,
        errorMessage,
      });
      logHop({
        hop: "consume",
        outcome: "error",
        meta,
        requestId: isV2Message(body) ? body.requestId : body?.requestId,
        messageId: message.id,
        provider: body?.provider,
        note: isV2Message(body) ? body.ingress : "legacy",
        disposition,
        error,
      });

      if (!permanentPayloadFailure) {
        emitCloudEvidence(
          env,
          ctx,
          buildEvidenceFromHop(meta, {
            path: "webhook.queue",
            kind: "queue_processing_error",
            outcome: "retry",
            severity: 6,
            requestId: isV2Message(body) ? body.requestId : body?.requestId,
            correlationIds: {
              messageId: message.id,
              ...(body?.provider ? { provider: body.provider } : {}),
              ...(isV2Message(body) ? { ingress: body.ingress } : {}),
            },
            summary: `webhook message processing failed on ${batch.queue} (provider=${body?.provider ?? "unknown"})`,
            counts: {
              errors: 1,
              attempts: message.attempts,
            },
            errorCode,
            errorMessage,
            inspect: {
              logQuery: `area:"nango-webhook-path" AND messageId:"${message.id}"`,
            },
          }),
        );
      }

      if (permanentPayloadFailure) {
        message.ack();
      } else {
        message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
      }
    }
  }

  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        const lane = lanes[index];
        if (!lane) {
          return;
        }
        for (const message of lane.messages) {
          await processOne(message);
        }
      }
    }),
  );

  logQueueEvent("info", "batch_processing_completed", null, "batch", {
    queue: batch.queue,
    messageCount: batch.messages.length,
    laneCount: lanes.length,
    concurrency,
    durationMs: elapsedMs(batchStartedAt),
  });
}
