import type {
  Env,
  GitLabHookdeckQueueMessage,
  NangoForwardQueueMessage,
  NangoSyncQueueMessage,
  WebhookPayloadRef,
  WebhookProvider,
  WebhookQueueMessage,
} from "./types";
import { logHop } from "@cloud/core/observability/structured-log.js";
import {
  newRequestId,
  type TelemetryMeta,
} from "@cloud/core/observability/telemetry-meta.js";

const INLINE_PAYLOAD_LIMIT_BYTES = 96 * 1024;

export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

export function getRequiredSecret(secret: string | undefined): string | null {
  return typeof secret === "string" && secret.length > 0 ? secret : null;
}

export function headersToRecord(headers: Headers): Record<string, string> {
  const copy: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    copy[key] = value;
  }
  return copy;
}

function readHeader(headers: Record<string, string>, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return value && value.length > 0 ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return undefined;
}

function readNangoIdentifierValue(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function readNangoProviderIdentifier(envelope: Record<string, unknown> | null): string | undefined {
  const payload = isObject(envelope?.payload) ? envelope.payload : {};
  const value =
    readNangoIdentifierValue(envelope?.from) ??
    readNangoIdentifierValue(envelope?.provider) ??
    readNangoIdentifierValue(payload.from) ??
    readNangoIdentifierValue(payload.provider);
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function hasSlackSignature(headers: Record<string, string>): boolean {
  return Boolean(
    readHeader(headers, "x-slack-signature") ??
      readHeader(headers, "x-slack-request-timestamp"),
  );
}

function inferProviderIdentifier(
  envelope: Record<string, unknown> | null,
  headers: Record<string, string>,
): string | undefined {
  const envelopeType = readString(envelope?.type);
  if (envelopeType !== "forward") {
    return undefined;
  }

  if (hasSlackSignature(headers)) {
    return "slack-relay";
  }

  return undefined;
}

function parseJsonObject(rawBody: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function createWebhookPayloadRef(
  env: Env,
  requestId: string,
  rawBody: string,
  receivedAt: string,
): Promise<WebhookPayloadRef> {
  const sizeBytes = new TextEncoder().encode(rawBody).byteLength;
  const sha256 = await sha256Hex(rawBody);

  if (sizeBytes <= INLINE_PAYLOAD_LIMIT_BYTES) {
    return {
      storage: "inline",
      body: rawBody,
      sizeBytes,
      sha256,
    };
  }

  if (!env.WEBHOOK_PAYLOADS) {
    throw new Error("WEBHOOK_PAYLOADS binding is required for large webhook payloads");
  }

  const datePrefix = receivedAt.slice(0, 10);
  const key = `${datePrefix}/${requestId}.body`;
  await env.WEBHOOK_PAYLOADS.put(key, rawBody, {
    httpMetadata: {
      contentType: "application/json",
    },
    customMetadata: {
      sha256,
      requestId,
    },
  });

  return {
    storage: "r2",
    bucket: "WEBHOOK_PAYLOADS",
    key,
    sizeBytes,
    sha256,
  };
}

function buildNangoMessage(
  base: Omit<NangoSyncQueueMessage, "ingress" | "nango" | "dedupe">,
  rawBody: string,
): NangoForwardQueueMessage | NangoSyncQueueMessage {
  const envelope = parseJsonObject(rawBody);
  const providerIdentifier =
    readNangoProviderIdentifier(envelope) ??
    inferProviderIdentifier(envelope, base.headers);
  const envelopeType = readString(envelope?.type);
  if (envelopeType === "forward") {
    const connectionId = readString(envelope?.connectionId);
    const payload = isObject(envelope?.payload) ? envelope.payload : {};
    return {
      ...base,
      ingress: "nango-forward",
      nango: {
        envelopeType,
        from: providerIdentifier,
        connectionId,
        providerConfigKey: readString(
          envelope?.providerConfigKey ??
            envelope?.provider_config_key ??
            providerIdentifier ??
            payload.from,
        ),
      },
      dedupe: {
        kind: "nango-forward",
        connectionId,
        deliveryId:
          readHeader(base.headers, "x-nango-delivery-id") ??
          readHeader(base.headers, "x-nango-webhook-id") ??
          readHeader(base.headers, "webhook-id"),
      },
    };
  }

  const payload = isObject(envelope?.payload) ? envelope.payload : {};
  const connectionId = readString(payload.connectionId ?? envelope?.connectionId);
  const syncName = readString(payload.syncName ?? payload.sync_name ?? envelope?.syncName);
  const model = readString(payload.model ?? envelope?.model);
  const queryTimeStamp = readString(
    payload.queryTimeStamp ??
      payload.queryTimestamp ??
      envelope?.queryTimeStamp ??
      envelope?.queryTimestamp,
  );
  const cursor = readString(payload.cursor ?? envelope?.cursor);

  return {
    ...base,
    ingress: "nango-sync",
    nango: {
      envelopeType,
      from: providerIdentifier,
      connectionId,
      providerConfigKey: readString(
        payload.providerConfigKey ??
          payload.provider_config_key ??
          envelope?.providerConfigKey ??
          envelope?.provider_config_key ??
          providerIdentifier,
      ),
      syncName,
      model,
      queryTimeStamp,
      cursor,
    },
    dedupe: {
      kind: "nango-sync",
      connectionId,
      syncName,
      model,
      windowKey: queryTimeStamp,
      cursorKey: cursor,
    },
  };
}

function buildGitLabHookdeckMessage(
  base: Omit<GitLabHookdeckQueueMessage, "ingress" | "gitlab" | "hookdeck" | "dedupe">,
  rawBody: string,
): GitLabHookdeckQueueMessage {
  const payload = parseJsonObject(rawBody);
  const project = isObject(payload?.project) ? payload.project : {};
  const eventUuid = readHeader(base.headers, "x-gitlab-event-uuid");

  return {
    ...base,
    ingress: "gitlab-hookdeck",
    gitlab: {
      event: readHeader(base.headers, "x-gitlab-event"),
      eventUuid,
      token: readHeader(base.headers, "x-gitlab-token"),
      projectId: readString(project.id),
    },
    hookdeck: {
      signature: readHeader(base.headers, "x-hookdeck-signature"),
      signature2: readHeader(base.headers, "x-hookdeck-signature-2"),
    },
    dedupe: {
      kind: "gitlab-hookdeck-delivery",
      deliveryId: eventUuid,
    },
  };
}

function looksLikeGitLabHookdeck(headers: Record<string, string>): boolean {
  return Boolean(
    readHeader(headers, "x-gitlab-event") ??
      readHeader(headers, "x-gitlab-event-uuid") ??
      readHeader(headers, "x-gitlab-token"),
  );
}

function readNangoDropDetails(rawBody: string, headers: Record<string, string>): {
  shouldDrop: boolean;
  connectionId?: string;
  syncName?: string;
} {
  const envelope = parseJsonObject(rawBody);
  const payload = isObject(envelope?.payload) ? envelope.payload : {};
  return {
    shouldDrop: !(
      readNangoProviderIdentifier(envelope) ??
      inferProviderIdentifier(envelope, headers)
    ),
    connectionId: readString(payload.connectionId ?? envelope?.connectionId),
    syncName: readString(payload.syncName ?? payload.sync_name ?? envelope?.syncName),
  };
}

async function buildWebhookQueueMessage(
  env: Env,
  provider: WebhookProvider,
  rawBody: string,
  headers: Headers,
): Promise<WebhookQueueMessage> {
  const receivedAt = new Date().toISOString();
  const requestId = newRequestId();
  const headerRecord = headersToRecord(headers);
  const payload = await createWebhookPayloadRef(env, requestId, rawBody, receivedAt);
  const base = {
    version: 2 as const,
    provider,
    payload,
    headers: headerRecord,
    receivedAt,
    requestId,
  };

  if (provider === "nango") {
    const nangoBase = {
      ...base,
      provider,
    };
    return looksLikeGitLabHookdeck(headerRecord)
      ? buildGitLabHookdeckMessage(nangoBase, rawBody)
      : buildNangoMessage(nangoBase, rawBody);
  }

  const genericProvider: Exclude<WebhookProvider, "nango"> = provider;
  return {
    ...base,
    provider: genericProvider,
    ingress: "provider-webhook",
    dedupe: {
      kind: "provider-delivery",
      provider: genericProvider,
      deliveryId:
        readHeader(headerRecord, "x-github-delivery") ??
        readHeader(headerRecord, "webhook-id") ??
        readHeader(headerRecord, "x-hookdeck-eventid"),
    },
  };
}

export async function enqueueAcceptedWebhook(
  env: Env,
  provider: WebhookProvider,
  body: string,
  headers: Headers,
  options: {
    meta?: TelemetryMeta;
  } = {},
): Promise<Response> {
  const headerRecord = headersToRecord(headers);
  if (provider === "nango" && !looksLikeGitLabHookdeck(headerRecord)) {
    const drop = readNangoDropDetails(body, headerRecord);
    if (drop.shouldDrop) {
      console.warn("[webhook-worker/ingest] nango_ingest_dropped_malformed", {
        area: "webhook-worker-ingest",
        provider,
        reason: "missing_nango_provider_identifier",
        connectionId: drop.connectionId,
        syncName: drop.syncName,
      });
      return jsonResponse(
        {
          accepted: true,
          dropped: true,
          reason: "missing_nango_provider_identifier",
        },
        { status: 202 },
      );
    }
  }

  const message = await buildWebhookQueueMessage(env, provider, body, headers);

  // Per-hop ingest log: includes requestId, provider, payload storage shape.
  // Downstream hops carry the requestId so a single correlation key links
  // ingest → enqueue → consume → dedup → write.
  const ingestNote = message.ingress === "nango-sync"
    ? "nango-sync"
    : message.ingress === "gitlab-hookdeck"
      ? "gitlab-hookdeck"
      : message.ingress === "nango-forward"
        ? "nango-forward"
        : "provider-webhook";
  logHop({
    hop: "ingest",
    outcome: "ok",
    meta: options.meta,
    requestId: message.requestId,
    provider: message.provider,
    note: `${ingestNote}:${message.payload.storage}:${message.payload.sizeBytes}b`,
  });

  try {
    await env.WEBHOOK_QUEUE.send(message);
  } catch (error) {
    logHop({
      hop: "enqueue",
      outcome: "error",
      meta: options.meta,
      requestId: message.requestId,
      provider: message.provider,
      error,
    });
    throw error;
  }

  logHop({
    hop: "enqueue",
    outcome: "ok",
    meta: options.meta,
    requestId: message.requestId,
    provider: message.provider,
    note: "webhook-events",
  });

  return jsonResponse(
    {
      accepted: true,
      queue: "webhook-events",
      messageId: message.requestId,
    },
    { status: 202 },
  );
}

export function invalidSignatureResponse(): Response {
  return jsonResponse({ error: "invalid_signature" }, { status: 401 });
}
