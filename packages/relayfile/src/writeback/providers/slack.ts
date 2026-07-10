import {
  resolveDeleteRequest as resolveSlackDeleteRequest,
  resolveWritebackRequest as resolveSlackWritebackRequest,
} from "@relayfile/adapter-slack/writeback";
import type { SlackWritebackRequest } from "@relayfile/adapter-slack/types";
import { nangoProxy } from "../nango.js";
import type {
  DispatchMetadata,
  DispatchResult,
  IntegrationCredential,
  ProviderDispatchOptions,
  WritebackEnv,
  WritebackInput,
} from "../types.js";
import {
  isRecord,
  isRetryableStatus,
  permanentFailure,
  readMessageFromPayload,
  retryableFailure,
  success,
} from "./common.js";

type SlackDirectMessageWritebackRequest = SlackWritebackRequest & {
  action: "post_dm";
  body: {
    users: string;
    return_im: true;
    message: Record<string, unknown>;
  };
};

type SlackPostIdempotencyClaim =
  | {
      kind: "claimed";
      key: string;
    }
  | {
      kind: "duplicate";
      key: string;
      externalId?: string;
    };

const DEFAULT_SLACK_WRITEBACK_IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60;
const SLACK_WRITEBACK_PENDING_LEASE_SECONDS = 5 * 60;

export async function dispatch(
  input: WritebackInput,
  cred: IntegrationCredential,
  env: WritebackEnv,
  options: ProviderDispatchOptions = {},
): Promise<DispatchResult> {
  let request: SlackWritebackRequest;
  try {
    request =
      input.action === "file_delete"
        ? resolveSlackDeleteRequest(input.path)
        : resolveSlackWritebackRequest(input.path, input.content);
  } catch (error) {
    return permanentFailure(error, { provider: "slack" });
  }

  // Parent-dependency writebacks: when this op declared a parent (parent_op_id),
  // the DO releases it from the parent's ack carrying the parent's delivered
  // provider object id (input.parentExternalId). Slack's use of that id is the
  // thread root: inject it as the chat.postMessage `thread_ts` (overriding any
  // path-segment value) so the reply threads onto the message the cloud just
  // posted — no agent-side receipt round-trip. Other providers interpret the
  // parent id their own way; here only post-message requests use it.
  if (input.parentExternalId && isSlackPostMessageWritebackRequest(request)) {
    (request.body as Record<string, unknown>).thread_ts = input.parentExternalId;
  }

  const metadata: DispatchMetadata = {
    provider: "slack",
    action: request.action,
    method: request.method,
    endpoint: request.endpoint,
  };

  if (isSlackDirectMessageWritebackRequest(request)) {
    return dispatchSlackDirectMessage(
      request,
      input,
      cred,
      env,
      options,
      metadata,
    );
  }

  if (isSlackPostMessageWritebackRequest(request)) {
    return dispatchSlackPostMessage(
      input,
      request,
      cred,
      env,
      options,
      metadata,
    );
  }

  const proxyEndpoint = toSlackProxyEndpoint(request.endpoint);
  try {
    const response = await nangoProxy<Record<string, unknown>>(
      cred,
      {
        method: request.method,
        endpoint: proxyEndpoint,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        data: request.body,
      },
      env,
      options,
    );
    return normalizeSlackProxyResponse(response, request.action, request.body, {
      ...metadata,
      endpoint: proxyEndpoint,
    });
  } catch (error) {
    return retryableFailure(error, metadata);
  }
}

/**
 * Read the optional client-supplied idempotency token off a resolved writeback
 * request. `@relayfile/adapter-slack` surfaces it from the draft's
 * `idempotencyKey` field (it is never forwarded to Slack). Read defensively so
 * this compiles against adapter-slack versions that predate the field — until
 * that release is deployed the value is simply absent and the content-hash
 * dedup applies.
 */
function readRequestIdempotencyKey(
  request: SlackWritebackRequest,
): string | undefined {
  const value = (request as { idempotencyKey?: unknown }).idempotencyKey;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isSlackPostMessageWritebackRequest(
  request: SlackWritebackRequest,
): request is SlackWritebackRequest & {
  endpoint: "/api/chat.postMessage";
  method: "POST";
  body: Record<string, unknown>;
} {
  return (
    request.endpoint === "/api/chat.postMessage" &&
    request.method.toUpperCase() === "POST" &&
    isRecord(request.body)
  );
}

function isSlackDirectMessageWritebackRequest(
  request: SlackWritebackRequest,
): request is SlackDirectMessageWritebackRequest {
  return (
    request.action === "post_dm" &&
    request.endpoint === "/api/conversations.open" &&
    isRecord(request.body) &&
    typeof request.body.users === "string" &&
    request.body.return_im === true &&
    isRecord(request.body.message)
  );
}

async function dispatchSlackPostMessage(
  input: WritebackInput,
  request: SlackWritebackRequest & { body: Record<string, unknown> },
  cred: IntegrationCredential,
  env: WritebackEnv,
  options: ProviderDispatchOptions,
  metadata: DispatchMetadata,
): Promise<DispatchResult> {
  return postSlackMessageWithIdempotency(
    input,
    cred,
    env,
    options,
    request.action,
    request.body,
    {
      ...metadata,
      endpoint: toSlackProxyEndpoint(request.endpoint),
    },
    readRequestIdempotencyKey(request),
  );
}

async function dispatchSlackDirectMessage(
  request: SlackDirectMessageWritebackRequest,
  input: WritebackInput,
  cred: IntegrationCredential,
  env: WritebackEnv,
  options: ProviderDispatchOptions,
  metadata: DispatchMetadata,
): Promise<DispatchResult> {
  const openEndpoint = "/conversations.open";
  const postEndpoint = "/chat.postMessage";
  try {
    const openResponse = await nangoProxy<Record<string, unknown>>(
      cred,
      {
        method: "POST",
        endpoint: openEndpoint,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        data: { users: request.body.users, return_im: true },
      },
      env,
      options,
    );
    const openBody = isRecord(openResponse.data) ? openResponse.data : null;
    const channel = readSlackConversationId(openBody);
    if (!openResponse.ok || openBody?.ok !== true) {
      return normalizeSlackProxyResponse(
        openResponse,
        request.action,
        request.body,
        { ...metadata, endpoint: openEndpoint },
      );
    }
    if (!channel) {
      return permanentFailure(
        "Slack conversations.open succeeded but did not return a channel id",
        { ...metadata, endpoint: openEndpoint, status: openResponse.status },
      );
    }
    return postSlackMessageWithIdempotency(
      input,
      cred,
      env,
      options,
      request.action,
      { ...request.body.message, channel },
      {
        ...metadata,
        endpoint: postEndpoint,
      },
      readRequestIdempotencyKey(request),
    );
  } catch (error) {
    return retryableFailure(error, metadata);
  }
}

async function postSlackMessageWithIdempotency(
  input: WritebackInput,
  cred: IntegrationCredential,
  env: WritebackEnv,
  options: ProviderDispatchOptions,
  action: string,
  requestBody: Record<string, unknown>,
  metadata: DispatchMetadata,
  clientIdempotencyKey?: string,
): Promise<DispatchResult> {
  let claim: SlackPostIdempotencyClaim;
  try {
    claim = await claimSlackPostIdempotency(
      input,
      cred,
      env,
      action,
      requestBody,
      clientIdempotencyKey,
    );
  } catch (error) {
    return retryableFailure(error, metadata);
  }

  const idempotencyMetadata = {
    ...metadata,
    idempotencyKey: claim.key,
  };
  if (claim.kind === "duplicate") {
    // Mirror the first-post aliases so a deduplicated (replayed) success still
    // satisfies the providerResult contract: ts comes from the stored external
    // id, channel from the request/claim body. Without this, an agent that
    // hits the idempotency path can't recover the ts to thread a reply.
    const channel = readOptionalString(requestBody.channel);
    return success(
      {
        ...idempotencyMetadata,
        status: 200,
        idempotencyDuplicate: true,
        ...(claim.externalId
          ? { externalId: claim.externalId, ts: claim.externalId }
          : {}),
        ...(channel ? { channel } : {}),
      },
      claim.externalId,
    );
  }

  try {
    const response = await nangoProxy<Record<string, unknown>>(
      cred,
      {
        method: "POST",
        endpoint: metadata.endpoint ?? "/chat.postMessage",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        data: requestBody,
      },
      env,
      options,
    );
    const result = normalizeSlackProxyResponse(
      response,
      action,
      requestBody,
      idempotencyMetadata,
    );
    if (result.outcome === "success") {
      await commitSlackPostIdempotency(env, claim.key, result.providerObjectId);
    } else {
      await releaseSlackPostIdempotency(env, claim.key);
    }
    return result;
  } catch (error) {
    await releaseSlackPostIdempotency(env, claim.key);
    return retryableFailure(error, idempotencyMetadata);
  }
}

async function claimSlackPostIdempotency(
  input: WritebackInput,
  cred: IntegrationCredential,
  env: WritebackEnv,
  action: string,
  requestBody: Record<string, unknown>,
  clientIdempotencyKey?: string,
): Promise<SlackPostIdempotencyClaim> {
  const db = requireSlackIdempotencyDb(env);
  const channel = readOptionalString(requestBody.channel);
  if (!channel) {
    throw new Error("Slack chat.postMessage writeback missing channel");
  }
  const threadTs = readOptionalString(requestBody.thread_ts) ?? "";
  const contentHash = await sha256Hex(stableStringify(requestBody));
  // When the client supplied a stable idempotency token (e.g. a scheduled tick's
  // `tick:<deliveryId>:<ordinal>`), key on THAT rather than the content hash, so
  // a re-run that regenerates slightly different content (drifting digest counts,
  // reordered links) still collapses onto the same key and is deduped. The token
  // already uniquely identifies the logical message, so channel/thread/action are
  // not part of the key in that case. Without a token, fall back to the original
  // content-hash dedup. (content_hash is still recorded on the row either way.)
  const key = `slack-post:${await sha256Hex(
    stableStringify(
      clientIdempotencyKey
        ? {
            workspaceId: input.workspaceId,
            providerConfigKey: cred.providerConfigKey,
            connectionId: cred.connectionId,
            clientIdempotencyKey,
          }
        : {
            workspaceId: input.workspaceId,
            providerConfigKey: cred.providerConfigKey,
            connectionId: cred.connectionId,
            channel,
            threadTs,
            action,
            contentHash,
          },
    ),
  )}`;
  const now = new Date();
  const nowIso = now.toISOString();
  await db
    .prepare(
      "DELETE FROM slack_writeback_idempotency WHERE key = ? AND expires_at <= ?",
    )
    .bind(key, nowIso)
    .run();

  const expiresAt = new Date(
    now.getTime() + slackWritebackIdempotencyTtlSeconds(env) * 1000,
  ).toISOString();
  const insert = await db
    .prepare(
      `INSERT OR IGNORE INTO slack_writeback_idempotency (
      key, workspace_id, provider_config_key, connection_id, channel, thread_ts,
      action, content_hash, status, created_at, expires_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      key,
      input.workspaceId,
      cred.providerConfigKey,
      cred.connectionId,
      channel,
      threadTs,
      action,
      contentHash,
      "pending",
      nowIso,
      expiresAt,
      nowIso,
    )
    .run();
  if ((insert.meta?.changes ?? 0) > 0) {
    return { kind: "claimed", key };
  }

  const existing = await db
    .prepare(
      "SELECT status, external_id, expires_at, updated_at FROM slack_writeback_idempotency WHERE key = ?",
    )
    .bind(key)
    .first<{
      status?: string;
      external_id?: string | null;
      expires_at?: string;
      updated_at?: string;
    }>();
  if (!existing) {
    return claimSlackPostIdempotency(input, cred, env, action, requestBody, clientIdempotencyKey);
  }
  if (existing?.expires_at && existing.expires_at <= nowIso) {
    await releaseSlackPostIdempotency(env, key);
    return claimSlackPostIdempotency(input, cred, env, action, requestBody, clientIdempotencyKey);
  }
  if (
    existing.status === "pending" &&
    isStaleSlackPostPendingClaim(existing.updated_at, now)
  ) {
    await releaseSlackPostIdempotency(env, key);
    return claimSlackPostIdempotency(input, cred, env, action, requestBody, clientIdempotencyKey);
  }
  return {
    kind: "duplicate",
    key,
    ...(existing?.external_id ? { externalId: existing.external_id } : {}),
  };
}

function isStaleSlackPostPendingClaim(
  updatedAt: string | undefined,
  now: Date,
): boolean {
  if (!updatedAt) {
    return true;
  }
  const updatedAtMs = Date.parse(updatedAt);
  return (
    !Number.isFinite(updatedAtMs) ||
    now.getTime() - updatedAtMs > SLACK_WRITEBACK_PENDING_LEASE_SECONDS * 1000
  );
}

async function commitSlackPostIdempotency(
  env: WritebackEnv,
  key: string,
  externalId?: string,
): Promise<void> {
  await requireSlackIdempotencyDb(env)
    .prepare(
      `UPDATE slack_writeback_idempotency
       SET external_id = ?, updated_at = ?, status = ?
     WHERE key = ?`,
    )
    .bind(externalId ?? null, new Date().toISOString(), "succeeded", key)
    .run();
}

async function releaseSlackPostIdempotency(
  env: WritebackEnv,
  key: string,
): Promise<void> {
  await requireSlackIdempotencyDb(env)
    .prepare(
      "DELETE FROM slack_writeback_idempotency WHERE key = ? AND status = 'pending'",
    )
    .bind(key)
    .run();
}

function requireSlackIdempotencyDb(env: WritebackEnv): D1Database {
  if (!env.DB) {
    throw new Error("Missing required binding: DB");
  }
  return env.DB;
}

function slackWritebackIdempotencyTtlSeconds(env: WritebackEnv): number {
  const raw = env.RELAYFILE_SLACK_WRITEBACK_IDEMPOTENCY_TTL_SECONDS?.trim();
  if (!raw) {
    return DEFAULT_SLACK_WRITEBACK_IDEMPOTENCY_TTL_SECONDS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 60
    ? parsed
    : DEFAULT_SLACK_WRITEBACK_IDEMPOTENCY_TTL_SECONDS;
}

function normalizeSlackProxyResponse(
  response: {
    ok: boolean;
    status: number;
    data: Record<string, unknown> | null;
  },
  action: string,
  requestBody: Record<string, unknown>,
  metadata: DispatchMetadata,
): DispatchResult {
  const body = isRecord(response.data) ? response.data : null;
  const slackOk = body?.ok === true;
  const slackError = typeof body?.error === "string" ? body.error : undefined;
  const externalId =
    slackOk && typeof body?.ts === "string"
      ? body.ts
      : slackOk &&
          action === "add_reaction" &&
          typeof requestBody.timestamp === "string"
        ? requestBody.timestamp
        : undefined;
  const channel =
    slackOk && typeof body?.channel === "string" ? body.channel : undefined;
  const responseMetadata = {
    ...metadata,
    status: response.status,
    ...(externalId ? { externalId, ts: externalId } : {}),
    ...(channel ? { channel } : {}),
    ...(slackError ? { slackError } : {}),
  };
  if (response.ok && slackOk) {
    return success(responseMetadata, externalId);
  }
  const message =
    (slackError &&
      actionableSlackWritebackError(
        slackError,
        readOptionalString(requestBody.channel),
      )) ??
    slackError ??
    readMessageFromPayload(
      response.data,
      `Slack writeback failed with status ${response.status}`,
    );
  const retryable =
    isRetryableStatus(response.status) ||
    [
      "ratelimited",
      "rate_limited",
      "service_unavailable",
      "internal_error",
      "fatal_error",
      "request_timeout",
    ].includes(slackError ?? "");
  return retryable
    ? retryableFailure(message, responseMetadata)
    : permanentFailure(message, responseMetadata);
}

/**
 * Map a known permanent, operator-actionable Slack API error code to a message
 * that says what to DO about it. Slack's raw codes (`not_in_channel`,
 * `missing_scope`, …) are surfaced verbatim on the writeback op's failure ack
 * (see acknowledgePermanentFailure), which is opaque to an operator staring at
 * "why didn't my agent post?". Returns undefined for unmapped codes so callers
 * fall back to the raw code. The raw code is still preserved in
 * `metadata.slackError`, so this only improves the human-facing message.
 */
export function actionableSlackWritebackError(
  code: string,
  channel: string | undefined,
): string | undefined {
  const where = channel ? ` (channel ${channel})` : "";
  switch (code) {
    case "not_in_channel":
      return `Slack bot is not a member of the channel${where}. Invite it with \`/invite @<your-app>\` in that channel, then retry.`;
    case "channel_not_found":
      return `Slack channel not found${where}. Check the channel id (e.g. the SLACK_CHANNEL input) and that the bot can see it — invite the bot to private channels.`;
    case "is_archived":
      return `Slack channel is archived${where}. Unarchive it or point the post at an active channel.`;
    case "missing_scope":
      return `Slack app is missing a required OAuth scope (posting needs \`chat:write\`). Reconnect the Slack integration to grant the updated scopes.`;
    case "not_authed":
    case "invalid_auth":
    case "account_inactive":
    case "token_revoked":
      return `Slack authentication is invalid or revoked. Reconnect the Slack integration for this workspace.`;
    case "restricted_action":
      return `Slack workspace policy blocked this post${where}. A workspace admin must allow the app to post here.`;
    default:
      return undefined;
  }
}

function readSlackConversationId(
  payload: Record<string, unknown> | null,
): string | undefined {
  if (!payload) return undefined;
  if (typeof payload.channel === "string") return payload.channel;
  if (isRecord(payload.channel) && typeof payload.channel.id === "string") {
    return payload.channel.id;
  }
  return undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toSlackProxyEndpoint(endpoint: string): string {
  return endpoint.startsWith("/api/")
    ? endpoint.slice("/api".length)
    : endpoint;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortForStableStringify(value));
}

function sortForStableStringify(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForStableStringify);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortForStableStringify(value[key])]),
  );
}
