import { GitHubWritebackHandler } from "@relayfile/adapter-github/writeback";
import { createHash } from "node:crypto";
import {
  GitLabWritebackHandler,
  type GitLabWritebackRequest,
} from "@relayfile/adapter-gitlab/writeback";
import {
  type ConnectionProvider as GitLabConnectionProvider,
  type ProxyRequest as GitLabProxyRequest,
  type ProxyResponse as GitLabProxyResponse,
} from "@relayfile/adapter-gitlab/types";
import {
  resolveConfluenceDeleteRequest,
  resolveConfluenceWritebackRequest,
} from "@relayfile/adapter-confluence/writeback";
import { type ConfluenceWritebackRequest } from "@relayfile/adapter-confluence/types";
import {
  resolveJiraDeleteRequest,
  resolveJiraWritebackRequest,
} from "@relayfile/adapter-jira/writeback";
import { type JiraWritebackRequest } from "@relayfile/adapter-jira/types";
import {
  resolveDeleteRequest as resolveLinearDeleteRequest,
  resolveWritebackRequest as resolveLinearWritebackRequest,
} from "@relayfile/adapter-linear/writeback";
import { type LinearWritebackRequest } from "@relayfile/adapter-linear/types";
import {
  extractLinearExternalId,
  extractLinearGraphQLErrors,
  extractLinearMutationOutcome,
  extractLinearRequestExternalId,
} from "./linear-writeback-response";
import {
  resolveDeleteRequest as resolveNotionDeleteRequest,
  resolveWritebackRequest,
} from "@relayfile/adapter-notion/writeback";
import {
  DEFAULT_NOTION_API_VERSION,
  type NotionWritebackRequest,
} from "@relayfile/adapter-notion/types";
import {
  resolveDeleteRequest as resolveSlackDeleteRequest,
  resolveWritebackRequest as resolveSlackWritebackRequest,
} from "@relayfile/adapter-slack/writeback";
import { type SlackWritebackRequest } from "@relayfile/adapter-slack/types";
import {
  resolveHubSpotDeleteRequest,
  resolveHubSpotWritebackRequest,
} from "@relayfile/adapter-hubspot/writeback";
import { type HubSpotWritebackRequest } from "@relayfile/adapter-hubspot/types";
import { resolveGoogleCalendarWritebackRequest } from "@relayfile/adapter-google-calendar/writeback";
import { type GoogleCalendarWritebackRequest } from "@relayfile/adapter-google-calendar/types";
import { RelayFileClient } from "@relayfile/sdk";
import { inferWritebackProviderForPath } from "./relayfile-writeback-catalog";
import { mintRelayfileToken } from "../../../core/src/relayfile/client";
import {
  getNangoClient,
  getProviderConfigKey,
} from "./nango-service";
import { resolveRelayfileConfig } from "../relayfile";
import {
  getWorkspaceIntegrationByProviderAlias,
  type WorkspaceIntegrationProviderAlias,
  type WorkspaceIntegrationRecord,
} from "./workspace-integrations";
import {
  resolveWorkspaceIntegrationIdentity,
  uniqueWorkspaceIds,
} from "../workspaces/workspace-integration-identity-core";
import { isWorkspaceIntegrationProvider } from "./providers";
import {
  findRelayfileWritebackReceipt,
  markRelayfileWritebackReceiptAcked,
  recordRelayfileWritebackReceipt,
  type RelayfileWritebackReceipt,
} from "./relayfile-writeback-receipts";
import {
  createSlackConversationEgress,
  resolveSlackConversationBotToken,
} from "./slack-conversation/egress";
import {
  claimSlackDirectProxyWriteback,
  completeSlackDirectProxyWriteback,
  releaseSlackDirectProxyWritebackClaim,
  waitForSlackDirectProxyWritebackResult,
  type SlackDirectProxyIdempotencyRecord,
} from "./slack-direct-proxy-writeback-idempotency";

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429]);
const BRIDGE_AGENT_NAME = "cloud-writeback-bridge";
// Bounded in-process retry budget for the relayfile ACK call. Transient
// relayfile blips (5xx, network resets) recover within the request; anything
// longer falls back to the durable `relayfile_ack_failed` retry loop, which
// the writeback receipt makes ack-only (no provider re-dispatch).
const ACK_MAX_ATTEMPTS = 4;
const ACK_RETRY_BASE_DELAY_MS = 250;
const SLACK_READ_ONLY_FIELDS = new Set([
  "id",
  "ts",
  "createdAt",
  "updatedAt",
  "url",
  "identifier",
  "provider",
  "objectType",
  "objectId",
  "workspaceId",
  "connectionId",
  "_webhook",
  "_connection",
]);
const TELEGRAM_READ_ONLY_FIELDS = new Set([
  "id",
  "createdAt",
  "updatedAt",
  "url",
  "identifier",
  "provider",
  "objectType",
  "objectId",
  "workspaceId",
  "connectionId",
  "_webhook",
  "_connection",
]);

/**
 * Providers the cloud can execute writebacks for, keyed by their relayfile
 * mount name. The mount names are catalog identities: provider-for-path
 * inference goes through `relayfile-writeback-catalog.ts` (generated from the
 * relayfile-adapters repo), and the drift test in
 * `relayfile-writeback-catalog.test.ts` rejects entries here that are neither
 * in the catalog nor documented in `CLOUD_ONLY_WRITEBACK_MOUNTS`.
 */
const WRITEBACK_EXECUTORS = {
  confluence: executeConfluenceWriteback,
  github: executeGitHubWriteback,
  gitlab: executeGitLabWriteback,
  "google-calendar": executeGoogleCalendarWriteback,
  "google-mail": executeGoogleMailWriteback,
  hubspot: executeHubSpotWriteback,
  jira: executeJiraWriteback,
  linear: executeLinearWriteback,
  notion: executeNotionWriteback,
  slack: executeSlackWriteback,
  telegram: executeTelegramWriteback,
} as const satisfies Record<
  string,
  (
    input: RelayfileWritebackInput,
    integration: WorkspaceIntegrationRecord,
  ) => Promise<RelayfileWritebackExecutionResult>
>;

// "dropbox" has no executor on purpose: its mount is metadata-only and the
// bridge rejects writebacks before any integration lookup (see
// executeRelayfileProviderWriteback), but it is still a provider the bridge
// recognizes and answers for.
type RelayfileProviderAlias = keyof typeof WRITEBACK_EXECUTORS | "dropbox";

/** Every provider the bridge recognizes, exported for the catalog drift test. */
export const BRIDGE_WRITEBACK_PROVIDERS: readonly RelayfileProviderAlias[] =
  Object.freeze(
    ([...Object.keys(WRITEBACK_EXECUTORS), "dropbox"] as RelayfileProviderAlias[]).sort(),
  );

type RetryableErrorCode =
  | "nango_proxy_failed"
  | "provider_request_failed"
  | "relayfile_ack_failed";

type PermanentErrorCode =
  | "integration_not_found"
  | "invalid_content"
  | "provider_mismatch"
  | "unsupported_path"
  | "unsupported_provider";

export type RelayfileWritebackInput = {
  opId: string;
  workspaceId: string;
  path: string;
  revision: string;
  correlationId: string;
  action?: "file_upsert" | "file_delete";
  content: string;
  contentType?: string;
  encoding?: string;
  provider?: string;
  // Server-side threading: the parent op's delivered provider object id, sent by
  // the relayfile-cloud bridge dispatcher. Slack uses it as chat.postMessage
  // thread_ts so the reply threads under the parent message.
  parentExternalId?: string;
};

export type RelayfileProviderResultMetadata = {
  provider: string;
  method?: string;
  endpoint?: string;
  action?: string;
  status?: number;
  externalId?: string;
};

export type RelayfileWritebackExecutionResult =
  | {
      outcome: "success";
      provider: string;
      metadata: RelayfileProviderResultMetadata;
    }
  | {
      outcome: "permanent_failure";
      provider: string;
      error: {
        code: PermanentErrorCode;
        message: string;
      };
      metadata?: RelayfileProviderResultMetadata;
    }
  | {
      outcome: "retryable_failure";
      provider: string;
      error: {
        code: RetryableErrorCode;
        message: string;
      };
      metadata?: RelayfileProviderResultMetadata;
    };

export type RelayfileWritebackResult = RelayfileWritebackExecutionResult & {
  relayfileAcked: boolean;
};

type NangoProxyResult<T = unknown> = {
  ok: boolean;
  status: number;
  headers: Headers;
  data: T | null;
};

type NotionProxyResponseBody = {
  id?: string | number;
};

type GitHubReviewCommentInput = {
  body: string;
  commitId?: string;
  path?: string;
  line?: number;
  side?: "LEFT" | "RIGHT";
  inReplyTo?: number;
};

type GitHubReviewCommentTarget = {
  owner: string;
  repo: string;
  prNumber: number;
};

type GitHubIssueWritebackRequest = {
  action: "create_issue" | "update_issue" | "create_issue_comment" | "update_issue_comment" | "add_issue_labels";
  method: "POST" | "PATCH";
  endpoint: string;
  body: Record<string, unknown>;
};

type GitHubMergePullRequestWritebackRequest = {
  action: "merge_pull_request";
  method: "PUT";
  endpoint: string;
  body: {
    merge_method: "merge" | "squash" | "rebase";
    commit_title?: string;
    commit_message?: string;
    sha?: string;
  };
  connectionId?: string;
  providerConfigKey?: string;
};

type GoogleMailWritebackRequest = {
  action:
    | "create_label"
    | "update_label"
    | "delete_label"
    | "create_filter"
    | "delete_filter"
    | "create_send_as"
    | "update_send_as"
    | "delete_send_as"
    | "send_message"
    | "modify_message"
    | "delete_message"
    | "modify_thread"
    | "delete_thread";
  method: "POST" | "PATCH" | "DELETE";
  endpoint: string;
  body?: Record<string, unknown>;
};

type SlackDirectMessageWritebackRequest = {
  action: "post_dm";
  method: "POST";
  endpoint: "/api/conversations.open";
  body: {
    users: string;
    return_im: true;
    message: Record<string, unknown>;
  };
};

export function sanitizeText(value: string): string {
  return value
    .replace(/authorization\s*:\s*bearer\s+[^\s"']+/gi, "Authorization: Bearer [REDACTED]")
    .replace(/bearer\s+[a-z0-9._-]+/gi, "Bearer [REDACTED]")
    .slice(0, 500);
}

export type WritebackDispatchBackend = "bridge" | "direct-proxy";

export function resolveWritebackDispatchBackend(input: {
  provider: string;
  action: string;
  integration: WorkspaceIntegrationRecord;
}): WritebackDispatchBackend {
  if (
    input.integration.writebackDispatchVia === "cf" &&
    (
      (input.provider === "slack" && isDirectProxyEligibleSlackAction(input.action)) ||
      (input.provider === "telegram" && isDirectProxyEligibleTelegramAction(input.action))
    )
  ) {
    return "direct-proxy";
  }
  return "bridge";
}

function isDirectProxyEligibleSlackAction(action: string): boolean {
  return (
    action === "reply_in_thread" ||
    action === "post_message" ||
    action === "add_reaction" ||
    action === "remove_reaction" ||
    action === "post_dm"
  );
}

function isDirectProxyEligibleTelegramAction(action: string): boolean {
  return (
    action === "send_message" ||
    action === "set_message_reaction" ||
    action === "answer_callback_query" ||
    action === "answer_inline_query" ||
    action === "set_my_commands" ||
    action === "set_chat_menu_button"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readIdempotencyKey(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const candidate = value.idempotencyKey;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

function slackDirectProxyLogicalIdempotencyKey(input: {
  workspaceId: string;
  providerConfigKey: string;
  connectionId: string;
  action: string;
  channel: string;
  threadTs?: string;
  payload: Record<string, unknown>;
}): string {
  const explicit = readIdempotencyKey(input.payload);
  const basis = explicit
    ? {
        workspaceId: input.workspaceId,
        providerConfigKey: input.providerConfigKey,
        connectionId: input.connectionId,
        action: input.action,
        channel: input.channel,
        threadTs: input.threadTs ?? null,
        idempotencyKey: explicit,
      }
    : {
        workspaceId: input.workspaceId,
        providerConfigKey: input.providerConfigKey,
        connectionId: input.connectionId,
        action: input.action,
        channel: input.channel,
        threadTs: input.threadTs ?? null,
        payload: input.payload,
      };
  return `slack-direct-proxy:${sha256Hex(stableJson(basis))}`;
}

function resultFromSlackDirectProxyIdempotencyRecord(
  record: SlackDirectProxyIdempotencyRecord,
  metadata: RelayfileProviderResultMetadata,
): RelayfileWritebackExecutionResult | null {
  if (record.status === "pending") {
    return null;
  }
  const resultMetadata = {
    ...metadata,
    ...(record.metadata ?? {}),
    ...(record.slackTs ? { externalId: record.slackTs } : {}),
  };
  if (record.status === "success") {
    return successResult("slack", resultMetadata);
  }
  return permanentFailure(
    "slack",
    (record.errorCode ?? "invalid_content") as PermanentErrorCode,
    record.errorMessage ?? "Slack direct-proxy writeback failed",
    resultMetadata,
  );
}

function isRelayfileProviderAlias(value: string): value is RelayfileProviderAlias {
  return value === "dropbox" || Object.hasOwn(WRITEBACK_EXECUTORS, value);
}

function isSlackDirectMessageWritebackRequest(
  request: SlackWritebackRequest | SlackDirectMessageWritebackRequest,
): request is SlackDirectMessageWritebackRequest {
  return (
    request.action === "post_dm" &&
    request.method === "POST" &&
    request.endpoint === "/api/conversations.open" &&
    isRecord(request.body) &&
    typeof request.body.users === "string" &&
    request.body.return_im === true &&
    isRecord(request.body.message)
  );
}

const GOOGLE_MAIL_SYSTEM_LABEL_IDS = new Set([
  "CHAT",
  "CATEGORY_FORUMS",
  "CATEGORY_PERSONAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
  "CATEGORY_UPDATES",
  "DRAFT",
  "IMPORTANT",
  "INBOX",
  "SENT",
  "SPAM",
  "STARRED",
  "TRASH",
  "UNREAD",
]);
const GOOGLE_MAIL_DRAFT_FILE_RE = /^(?:draft|create|new|tmp|temp)(?:[._-]|$)/i;

export function isRelayfileWritebackInput(
  value: unknown,
): value is RelayfileWritebackInput {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.opId === "string" &&
    typeof value.workspaceId === "string" &&
    typeof value.path === "string" &&
    typeof value.revision === "string" &&
    typeof value.correlationId === "string" &&
    (value.action === undefined ||
      value.action === "file_upsert" ||
      value.action === "file_delete") &&
    typeof value.content === "string" &&
    (value.contentType === undefined || typeof value.contentType === "string") &&
    (value.encoding === undefined || typeof value.encoding === "string") &&
    (value.provider === undefined || typeof value.provider === "string") &&
    (value.parentExternalId === undefined ||
      typeof value.parentExternalId === "string")
  );
}

/**
 * Provider inference is catalog-driven: the mount's first segment must be a
 * provider the adapters-repo catalog (or a documented cloud-only mount) knows
 * about, and the bridge must have an executor for it. Catalog providers the
 * bridge cannot execute yet (asana, clickup, ...) resolve to null and surface
 * as the same `unsupported_path` permanent failure as before.
 */
function inferProviderFromPath(path: string): RelayfileProviderAlias | null {
  const provider = inferWritebackProviderForPath(path);
  return provider !== null && isRelayfileProviderAlias(provider) ? provider : null;
}

function normalizeRequestedProvider(provider?: string): RelayfileProviderAlias | null {
  const trimmed = provider?.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("slack")) {
    return "slack";
  }
  if (trimmed === "google-mail-relay" || trimmed === "gmail") {
    return "google-mail";
  }
  if (trimmed === "dropbox-relay") {
    return "dropbox";
  }

  return isRelayfileProviderAlias(trimmed) ? trimmed : null;
}

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS_CODES.has(status) || status >= 500;
}

function readMessageFromPayload(
  payload: unknown,
  fallback: string,
): string {
  if (typeof payload === "string" && payload.trim().length > 0) {
    return sanitizeText(payload.trim());
  }

  if (!isRecord(payload)) {
    return fallback;
  }

  const directMessage = payload.message;
  if (typeof directMessage === "string" && directMessage.trim().length > 0) {
    return sanitizeText(directMessage.trim());
  }

  const directError = payload.error;
  if (typeof directError === "string" && directError.trim().length > 0) {
    return sanitizeText(directError.trim());
  }

  return fallback;
}

function resolveGoogleMailWritebackRequest(
  input: RelayfileWritebackInput,
): GoogleMailWritebackRequest {
  const parsed = parseGoogleMailPath(input.path);
  if (!parsed) {
    throw new Error(`No Google Mail writeback rule matched ${input.path}`);
  }

  if (input.action === "file_delete") {
    return resolveGoogleMailDeleteRequest(parsed);
  }

  const payload = safeParseJson(input.content);
  if (!isRecord(payload)) {
    throw new Error("Google Mail writeback requires a JSON object payload");
  }

  switch (parsed.resource) {
    case "labels":
      return resolveGoogleMailLabelUpsert(parsed.fileId, payload);
    case "filters":
      return resolveGoogleMailFilterUpsert(parsed.fileId, payload);
    case "send-as":
      return resolveGoogleMailSendAsUpsert(parsed.fileId, payload);
    case "messages":
      return resolveGoogleMailMessageUpsert(parsed.fileId, payload);
    case "threads":
      return resolveGoogleMailThreadUpsert(parsed.fileId, payload);
  }
}

type GoogleMailPath = {
  resource: "labels" | "filters" | "send-as" | "messages" | "threads";
  fileId: string;
};

function parseGoogleMailPath(path: string): GoogleMailPath | null {
  const match = path
    .trim()
    .match(
      /^\/google-mail\/(labels|filters|send-as|messages|threads)\/([^/]+)\.json$/u,
    );
  if (!match?.[1] || !match[2] || isReservedJsonFile(match[2])) {
    return null;
  }
  return {
    resource: match[1] as GoogleMailPath["resource"],
    fileId: decodeURIComponent(match[2]),
  };
}

function resolveGoogleMailDeleteRequest(
  parsed: GoogleMailPath,
): GoogleMailWritebackRequest {
  switch (parsed.resource) {
    case "labels":
      if (!isCanonicalGoogleMailLabelId(parsed.fileId)) {
        throw new Error("label delete writeback requires a canonical Gmail label id");
      }
      return {
        action: "delete_label",
        method: "DELETE",
        endpoint: `/gmail/v1/users/me/labels/${encodeURIComponent(parsed.fileId)}`,
      };
    case "filters":
      return {
        action: "delete_filter",
        method: "DELETE",
        endpoint: `/gmail/v1/users/me/settings/filters/${encodeURIComponent(parsed.fileId)}`,
      };
    case "send-as":
      return {
        action: "delete_send_as",
        method: "DELETE",
        endpoint: `/gmail/v1/users/me/settings/sendAs/${encodeURIComponent(parsed.fileId)}`,
      };
    case "messages":
      return {
        action: "delete_message",
        method: "DELETE",
        endpoint: `/gmail/v1/users/me/messages/${encodeURIComponent(parsed.fileId)}`,
      };
    case "threads":
      return {
        action: "delete_thread",
        method: "DELETE",
        endpoint: `/gmail/v1/users/me/threads/${encodeURIComponent(parsed.fileId)}`,
      };
  }
}

function resolveGoogleMailLabelUpsert(
  fileId: string,
  payload: Record<string, unknown>,
): GoogleMailWritebackRequest {
  const create = !isCanonicalGoogleMailLabelId(fileId);
  const body = pickGoogleMailFields(payload, [
    "name",
    "messageListVisibility",
    "labelListVisibility",
  ]);
  const color = pickGoogleMailFields(payload, ["textColor", "backgroundColor"]);
  if (Object.keys(color).length > 0) {
    body.color = color;
  }
  if (create && !readString(payload, "name")) {
    throw new Error("label create writeback requires `name`");
  }
  if (!create && Object.keys(body).length === 0) {
    throw new Error(
      "label update writeback requires at least one mutable label field",
    );
  }
  return create
    ? {
        action: "create_label",
        method: "POST",
        endpoint: "/gmail/v1/users/me/labels",
        body,
      }
    : {
        action: "update_label",
        method: "PATCH",
        endpoint: `/gmail/v1/users/me/labels/${encodeURIComponent(fileId)}`,
        body,
      };
}

function resolveGoogleMailFilterUpsert(
  fileId: string,
  payload: Record<string, unknown>,
): GoogleMailWritebackRequest {
  if (!isDraftLikeGoogleMailFile(fileId) && samePayloadId(payload, fileId)) {
    throw new Error(
      "Gmail filters cannot be updated in place; delete and recreate the filter",
    );
  }
  const body = normalizeGoogleMailFilterBody(payload);
  if (!isRecord(body.criteria) || Object.keys(body.criteria).length === 0) {
    throw new Error("filter create writeback requires `criteria`");
  }
  if (!isRecord(body.action) || Object.keys(body.action).length === 0) {
    throw new Error("filter create writeback requires `action`");
  }
  return {
    action: "create_filter",
    method: "POST",
    endpoint: "/gmail/v1/users/me/settings/filters",
    body,
  };
}

function resolveGoogleMailSendAsUpsert(
  fileId: string,
  payload: Record<string, unknown>,
): GoogleMailWritebackRequest {
  const payloadEmail =
    readString(payload, "sendAsEmail") ?? readString(payload, "id");
  const create =
    isDraftLikeGoogleMailFile(fileId) ||
    (payloadEmail !== undefined && payloadEmail !== fileId);
  const body = pickGoogleMailFields(payload, [
    "sendAsEmail",
    "displayName",
    "replyToAddress",
    "signature",
    "isDefault",
    "treatAsAlias",
    "smtpMsa",
  ]);
  if (create && !readString(payload, "sendAsEmail")) {
    throw new Error("send-as create writeback requires `sendAsEmail`");
  }
  if (!create) {
    delete body.sendAsEmail;
    if (Object.keys(body).length === 0) {
      throw new Error(
        "send-as update writeback requires at least one mutable alias field",
      );
    }
  }
  return create
    ? {
        action: "create_send_as",
        method: "POST",
        endpoint: "/gmail/v1/users/me/settings/sendAs",
        body,
      }
    : {
        action: "update_send_as",
        method: "PATCH",
        endpoint: `/gmail/v1/users/me/settings/sendAs/${encodeURIComponent(fileId)}`,
        body,
      };
}

function resolveGoogleMailMessageUpsert(
  fileId: string,
  payload: Record<string, unknown>,
): GoogleMailWritebackRequest {
  if (isDraftLikeGoogleMailFile(fileId) || !samePayloadId(payload, fileId)) {
    const body = pickGoogleMailFields(payload, ["raw", "threadId"]);
    if (!readString(payload, "raw")) {
      throw new Error(
        "message send writeback requires base64url `raw` RFC 2822 content",
      );
    }
    return {
      action: "send_message",
      method: "POST",
      endpoint: "/gmail/v1/users/me/messages/send",
      body,
    };
  }
  const body = pickGoogleMailFields(payload, ["addLabelIds", "removeLabelIds"]);
  if (Object.keys(body).length === 0) {
    throw new Error(
      "message update writeback requires `addLabelIds` or `removeLabelIds`",
    );
  }
  return {
    action: "modify_message",
    method: "POST",
    endpoint: `/gmail/v1/users/me/messages/${encodeURIComponent(fileId)}/modify`,
    body,
  };
}

function resolveGoogleMailThreadUpsert(
  fileId: string,
  payload: Record<string, unknown>,
): GoogleMailWritebackRequest {
  if (isDraftLikeGoogleMailFile(fileId) || !samePayloadId(payload, fileId)) {
    throw new Error(
      "Gmail thread create writeback is not supported; create/send a message instead",
    );
  }
  const body = pickGoogleMailFields(payload, ["addLabelIds", "removeLabelIds"]);
  if (Object.keys(body).length === 0) {
    throw new Error(
      "thread update writeback requires `addLabelIds` or `removeLabelIds`",
    );
  }
  return {
    action: "modify_thread",
    method: "POST",
    endpoint: `/gmail/v1/users/me/threads/${encodeURIComponent(fileId)}/modify`,
    body,
  };
}

function normalizeGoogleMailFilterBody(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const criteria = isRecord(payload.criteria)
    ? pickGoogleMailFields(payload.criteria, [
        "from",
        "to",
        "subject",
        "query",
        "negatedQuery",
        "hasAttachment",
        "excludeChats",
        "size",
        "sizeComparison",
      ])
    : pickGoogleMailFields(payload, [
        "from",
        "to",
        "subject",
        "query",
        "negatedQuery",
        "hasAttachment",
        "excludeChats",
        "size",
        "sizeComparison",
      ]);
  const action = isRecord(payload.action)
    ? pickGoogleMailFields(payload.action, [
        "addLabelIds",
        "removeLabelIds",
        "forward",
      ])
    : pickGoogleMailFields(payload, ["addLabelIds", "removeLabelIds", "forward"]);
  return { criteria, action };
}

function pickGoogleMailFields(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) {
      body[key] = source[key];
    }
  }
  return body;
}

function samePayloadId(payload: Record<string, unknown>, fileId: string): boolean {
  return readString(payload, "id") === fileId;
}

function isReservedJsonFile(fileId: string): boolean {
  return fileId === "_index" || fileId === "meta" || fileId === "metadata";
}

function isDraftLikeGoogleMailFile(fileId: string): boolean {
  return GOOGLE_MAIL_DRAFT_FILE_RE.test(fileId);
}

function isCanonicalGoogleMailLabelId(fileId: string): boolean {
  return /^Label_\d+$/u.test(fileId) || GOOGLE_MAIL_SYSTEM_LABEL_IDS.has(fileId);
}

function extractExternalId(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  const id = payload.id;
  if (typeof id === "string" || typeof id === "number") {
    return String(id);
  }

  return undefined;
}

export type GitHubCommitPatchOperation =
  | {
      kind: "upsert";
      path: string;
      content: string;
      contentEncoding?: "utf-8" | "base64";
      previousPath?: string;
    }
  | {
      kind: "delete";
      path: string;
    };

export type GitHubCommitPatchStrategy = "contents_api" | "git_db";

export type GitHubCommitPatchResult = {
  sha: string;
  strategy: GitHubCommitPatchStrategy;
};

export type GitHubCommitPatchRequester = <T = Record<string, unknown>>(input: {
  method: string;
  endpoint: string;
  data?: unknown;
}) => Promise<{ status: number; data: T | null }>;

class GitHubTooLargeContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubTooLargeContentError";
  }
}

function getGitHubApiBaseUrl(): string {
  return (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
}

function encodePathSegments(value: string): string {
  return value
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function encodeGitRef(value: string): string {
  return encodePathSegments(value);
}

function encodeBase64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function isTooLargeContentsResponse(status: number, payload: unknown): boolean {
  if (status === 413) return true;
  if (status !== 422) return false;

  const message = readMessageFromPayload(payload, "");
  return /too large|large file|exceeds|size limit|greater than/i.test(message);
}

async function readGitHubResponsePayload(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function githubRequest<T = Record<string, unknown>>(input: {
  token: string;
  method: string;
  endpoint: string;
  data?: unknown;
  fetchImpl?: typeof fetch;
}): Promise<{ status: number; data: T | null }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(`${getGitHubApiBaseUrl()}${input.endpoint}`, {
    method: input.method,
    headers: {
      Authorization: `Bearer ${input.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: input.data === undefined ? undefined : JSON.stringify(input.data),
    cache: "no-store",
  });
  const payload = await readGitHubResponsePayload(response);

  if (!response.ok) {
    if (isTooLargeContentsResponse(response.status, payload)) {
      throw new GitHubTooLargeContentError(
        readMessageFromPayload(payload, `GitHub Contents API rejected a large file with status ${response.status}`),
      );
    }
    throw new Error(readMessageFromPayload(payload, `GitHub API request failed with status ${response.status}`));
  }

  return { status: response.status, data: payload as T | null };
}

async function getContentsSha(input: {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const endpoint = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/contents/${encodePathSegments(input.path)}?ref=${encodeURIComponent(input.branch)}`;
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(`${getGitHubApiBaseUrl()}${endpoint}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${input.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    cache: "no-store",
  });
  const payload = await readGitHubResponsePayload(response);
  if (response.status === 404) return null;
  if (!response.ok) {
    if (isTooLargeContentsResponse(response.status, payload)) {
      throw new GitHubTooLargeContentError(
        readMessageFromPayload(payload, `GitHub Contents API rejected a large file with status ${response.status}`),
      );
    }
    throw new Error(readMessageFromPayload(payload, `GitHub Contents lookup failed with status ${response.status}`));
  }
  if (!isRecord(payload) || typeof payload.sha !== "string" || payload.sha.length === 0) {
    throw new Error(`GitHub Contents lookup for ${input.path} did not return sha`);
  }
  return payload.sha;
}

async function putContentsFile(input: {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  content: string;
  message: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const sha = await getContentsSha(input);
  const response = await githubRequest<Record<string, unknown>>({
    token: input.token,
    method: "PUT",
    endpoint: `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/contents/${encodePathSegments(input.path)}`,
    data: {
      message: input.message,
      branch: input.branch,
      content: encodeBase64(input.content),
      ...(sha ? { sha } : {}),
    },
    fetchImpl: input.fetchImpl,
  });

  const commit = isRecord(response.data?.commit) ? response.data.commit : null;
  const commitSha = typeof commit?.sha === "string" ? commit.sha : null;
  if (!commitSha) {
    throw new Error(`GitHub Contents upsert for ${input.path} did not return commit sha`);
  }
  return commitSha;
}

async function deleteContentsFile(input: {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  message: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const sha = await getContentsSha(input);
  if (!sha) return null;

  const response = await githubRequest<Record<string, unknown>>({
    token: input.token,
    method: "DELETE",
    endpoint: `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/contents/${encodePathSegments(input.path)}`,
    data: {
      message: input.message,
      branch: input.branch,
      sha,
    },
    fetchImpl: input.fetchImpl,
  });

  const commit = isRecord(response.data?.commit) ? response.data.commit : null;
  const commitSha = typeof commit?.sha === "string" ? commit.sha : null;
  if (!commitSha) {
    throw new Error(`GitHub Contents delete for ${input.path} did not return commit sha`);
  }
  return commitSha;
}

async function commitViaContentsApi(input: {
  owner: string;
  repo: string;
  branch: string;
  operations: GitHubCommitPatchOperation[];
  token: string;
  message: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  let headSha: string | null = null;
  for (const operation of input.operations) {
    if (operation.kind === "delete") {
      headSha = await deleteContentsFile({
        owner: input.owner,
        repo: input.repo,
        branch: input.branch,
        path: operation.path,
        message: input.message,
        token: input.token,
        fetchImpl: input.fetchImpl,
      }) ?? headSha;
      continue;
    }

    if (operation.previousPath && operation.previousPath !== operation.path) {
      headSha = await deleteContentsFile({
        owner: input.owner,
        repo: input.repo,
        branch: input.branch,
        path: operation.previousPath,
        message: input.message,
        token: input.token,
        fetchImpl: input.fetchImpl,
      }) ?? headSha;
    }

    headSha = await putContentsFile({
      owner: input.owner,
      repo: input.repo,
      branch: input.branch,
      path: operation.path,
      content: operation.content,
      message: input.message,
      token: input.token,
      fetchImpl: input.fetchImpl,
    });
  }

  if (!headSha) {
    throw new Error("No GitHub Contents API commit was created");
  }
  return headSha;
}

export async function commitViaGitDatabaseRequest(input: {
  owner: string;
  repo: string;
  branch: string;
  baseSha: string;
  operations: GitHubCommitPatchOperation[];
  message: string;
  request: GitHubCommitPatchRequester;
  branchMode?: "update" | "create_or_update";
}): Promise<string> {
  const repoPath = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
  const baseCommit = await input.request<Record<string, unknown>>({
    method: "GET",
    endpoint: `${repoPath}/git/commits/${encodeURIComponent(input.baseSha)}`,
  });
  const tree = isRecord(baseCommit.data?.tree) ? baseCommit.data.tree : null;
  const baseTreeSha = typeof tree?.sha === "string" ? tree.sha : null;
  if (!baseTreeSha) {
    throw new Error(`GitHub base commit ${input.baseSha} did not return tree sha`);
  }

  const treeEntries: Array<Record<string, unknown>> = [];
  const deletedPaths = new Set<string>();
  for (const operation of input.operations) {
    if (operation.kind === "delete") {
      deletedPaths.add(operation.path);
      treeEntries.push({
        path: operation.path,
        mode: "100644",
        type: "blob",
        sha: null,
      });
      continue;
    }

    if (operation.previousPath && operation.previousPath !== operation.path && !deletedPaths.has(operation.previousPath)) {
      deletedPaths.add(operation.previousPath);
      treeEntries.push({
        path: operation.previousPath,
        mode: "100644",
        type: "blob",
        sha: null,
      });
    }

    const blob = await input.request<Record<string, unknown>>({
      method: "POST",
      endpoint: `${repoPath}/git/blobs`,
      data: {
        content: operation.content,
        encoding: operation.contentEncoding ?? "utf-8",
      },
    });
    const blobSha = typeof blob.data?.sha === "string" ? blob.data.sha : null;
    if (!blobSha) {
      throw new Error(`GitHub blob create for ${operation.path} did not return sha`);
    }
    treeEntries.push({
      path: operation.path,
      mode: "100644",
      type: "blob",
      sha: blobSha,
    });
  }

  const nextTree = await input.request<Record<string, unknown>>({
    method: "POST",
    endpoint: `${repoPath}/git/trees`,
    data: {
      base_tree: baseTreeSha,
      tree: treeEntries,
    },
  });
  const nextTreeSha = typeof nextTree.data?.sha === "string" ? nextTree.data.sha : null;
  if (!nextTreeSha) {
    throw new Error("GitHub tree create did not return sha");
  }

  const commit = await input.request<Record<string, unknown>>({
    method: "POST",
    endpoint: `${repoPath}/git/commits`,
    data: {
      message: input.message,
      tree: nextTreeSha,
      parents: [input.baseSha],
    },
  });
  const commitSha = typeof commit.data?.sha === "string" ? commit.data.sha : null;
  if (!commitSha) {
    throw new Error("GitHub commit create did not return sha");
  }

  if (input.branchMode === "create_or_update") {
    try {
      await input.request<Record<string, unknown>>({
        method: "POST",
        endpoint: `${repoPath}/git/refs`,
        data: {
          ref: `refs/heads/${input.branch}`,
          sha: commitSha,
        },
      });
    } catch (error) {
      if (
        !isRecord(error) ||
        typeof error.status !== "number" ||
        error.status !== 422
      ) {
        throw error;
      }
      await input.request<Record<string, unknown>>({
        method: "PATCH",
        endpoint: `${repoPath}/git/refs/heads/${encodeGitRef(input.branch)}`,
        data: {
          sha: commitSha,
          force: true,
        },
      });
    }
  } else {
    await input.request<Record<string, unknown>>({
      method: "PATCH",
      endpoint: `${repoPath}/git/refs/heads/${encodeGitRef(input.branch)}`,
      data: {
        sha: commitSha,
        force: true,
      },
    });
  }

  return commitSha;
}

async function commitViaGitDatabase(input: {
  owner: string;
  repo: string;
  branch: string;
  baseSha: string;
  operations: GitHubCommitPatchOperation[];
  token: string;
  message: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  return commitViaGitDatabaseRequest({
    owner: input.owner,
    repo: input.repo,
    branch: input.branch,
    baseSha: input.baseSha,
    operations: input.operations,
    message: input.message,
    request: (request) => githubRequest({
      token: input.token,
      fetchImpl: input.fetchImpl,
      ...request,
    }),
  });
}

export async function commitPatch(input: {
  owner: string;
  repo: string;
  branch: string;
  baseSha: string;
  operations: GitHubCommitPatchOperation[];
  token: string;
  message: string;
  fetchImpl?: typeof fetch;
}): Promise<GitHubCommitPatchResult> {
  try {
    const sha = await commitViaContentsApi(input);
    return { sha, strategy: "contents_api" };
  } catch (error) {
    if (!(error instanceof GitHubTooLargeContentError)) {
      throw error;
    }
  }

  try {
    const sha = await commitViaGitDatabase(input);
    return { sha, strategy: "git_db" };
  } catch (error) {
    if (error instanceof GitHubTooLargeContentError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Git Database fallback failed: ${sanitizeText(message)}`);
  }
}

function permanentFailure(
  provider: string,
  code: PermanentErrorCode,
  message: string,
  metadata?: RelayfileProviderResultMetadata,
): RelayfileWritebackExecutionResult {
  return {
    outcome: "permanent_failure",
    provider,
    error: {
      code,
      message: sanitizeText(message),
    },
    ...(metadata ? { metadata } : {}),
  };
}

function retryableFailure(
  provider: string,
  code: RetryableErrorCode,
  message: string,
  metadata?: RelayfileProviderResultMetadata,
): RelayfileWritebackExecutionResult {
  return {
    outcome: "retryable_failure",
    provider,
    error: {
      code,
      message: sanitizeText(message),
    },
    ...(metadata ? { metadata } : {}),
  };
}

function successResult(
  provider: string,
  metadata: RelayfileProviderResultMetadata,
): RelayfileWritebackExecutionResult {
  return {
    outcome: "success",
    provider,
    metadata,
  };
}

function createRelayfileClient(
  workspaceId: string,
  fetchImpl?: typeof fetch,
): RelayFileClient {
  const { relayfileUrl, relayAuthUrl, relayAuthApiKey } = resolveRelayfileConfig();
  if (!relayfileUrl || !relayAuthApiKey) {
    throw new Error("Relayfile is not configured.");
  }

  return new RelayFileClient({
    baseUrl: relayfileUrl,
    token: () => mintRelayfileToken({
      workspaceId,
      relayAuthUrl,
      relayAuthApiKey,
      agentName: BRIDGE_AGENT_NAME,
    }),
    fetchImpl,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ackRetryDelayMs(attempt: number): number {
  // 250ms, 500ms, 1000ms, ... before attempts 2, 3, 4, ...
  return ACK_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 2);
}

function isRetryableAckStatus(status: number): boolean {
  return status >= 500 || RETRYABLE_STATUS_CODES.has(status);
}

async function ackRelayfileWriteback(
  input: Pick<RelayfileWritebackInput, "opId" | "workspaceId" | "correlationId">,
  success: boolean,
  error?: string,
  providerResult?: RelayfileProviderResultMetadata,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const client = createRelayfileClient(input.workspaceId, fetchImpl);
  const url = `${client.getBaseUrl()}/v1/workspaces/${encodeURIComponent(input.workspaceId)}/writeback/${encodeURIComponent(input.opId)}/ack`;
  const body = JSON.stringify({
    success,
    ...(error ? { error } : {}),
    ...(providerResult ? { providerResult } : {}),
  });

  let lastFailure: Error | null = null;
  for (let attempt = 1; attempt <= ACK_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      await sleep(ackRetryDelayMs(attempt));
    }

    let response: Response;
    try {
      response = await (fetchImpl ?? fetch)(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await client.getToken()}`,
          "Content-Type": "application/json",
          "X-Correlation-Id": input.correlationId,
        },
        body,
      });
    } catch (networkError) {
      // Network-level failures (connection reset, DNS, timeout) are transient.
      lastFailure = new Error(
        `Relayfile writeback ACK request failed: ${sanitizeText(
          networkError instanceof Error ? networkError.message : String(networkError),
        )}`,
      );
      continue;
    }

    if (response.ok) {
      return;
    }

    // 404 means the op is no longer pending on relayfile (already acked by a
    // prior attempt whose response was lost, or swept). The ack is owed to
    // nobody — treat as idempotent success instead of poisoning retries.
    if (response.status === 404) {
      return;
    }

    const message = await response.text().catch(() => "");
    const failure = new Error(
      `Relayfile writeback ACK failed with status ${response.status}: ${sanitizeText(message)}`,
    );
    if (!isRetryableAckStatus(response.status)) {
      // Permanent (4xx) failure: retrying with the same request cannot help.
      throw failure;
    }
    lastFailure = failure;
  }

  throw lastFailure ?? new Error("Relayfile writeback ACK failed");
}

/**
 * This is the Nango-backed proxy path. When the backend registry lands,
 * wrap callers in `getIntegrationBackend(backend).proxy(...)` and keep this
 * function as the Nango branch.
 */
async function proxyThroughNango<T = unknown>(input: {
  connectionId: string;
  backendIntegrationId: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  endpoint: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  data?: unknown;
}): Promise<NangoProxyResult<T>> {
  const client = getNangoClient();
  try {
    const response = await client.proxy<T>({
      method: input.method,
      endpoint: input.endpoint,
      connectionId: input.connectionId,
      providerConfigKey: input.backendIntegrationId,
      ...(input.headers ? { headers: input.headers } : {}),
      ...(input.params ? { params: input.params } : {}),
      ...(input.data === undefined ? {} : { data: input.data }),
    });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      headers: axiosHeadersToWeb(response.headers),
      data: (response.data ?? null) as T | null,
    };
  } catch (error) {
    const info = readAxiosErrorResponse(error);
    if (!info) throw error;
    return {
      ok: false,
      status: info.status,
      headers: axiosHeadersToWeb(info.headers),
      data: (info.data ?? null) as T | null,
    };
  }
}

function readAxiosErrorResponse(error: unknown):
  | { status: number; data: unknown; headers: unknown }
  | null {
  if (!error || typeof error !== "object") return null;
  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== "object") return null;
  const status = (response as { status?: unknown }).status;
  if (typeof status !== "number") return null;
  return {
    status,
    data: (response as { data?: unknown }).data,
    headers: (response as { headers?: unknown }).headers,
  };
}

function axiosHeadersToWeb(headers: unknown): Headers {
  const out = new Headers();
  if (headers && typeof headers === "object") {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (typeof value === "string") {
        out.set(key, value);
      } else if (Array.isArray(value)) {
        for (const entry of value) {
          if (typeof entry === "string") out.append(key, entry);
        }
      } else if (value !== undefined && value !== null) {
        out.set(key, String(value));
      }
    }
  }
  return out;
}

async function resolveWorkspaceIntegrationForWriteback(
  workspaceId: string,
  provider: RelayfileProviderAlias,
): Promise<{
  integration: WorkspaceIntegrationRecord | null;
  candidateWorkspaceIds: readonly string[];
}> {
  const lookupProvider: WorkspaceIntegrationProviderAlias =
    provider === "slack" ? "slack" : provider;
  const identity = await resolveWorkspaceIntegrationIdentity(workspaceId);
  const candidateWorkspaceIds = uniqueWorkspaceIds([
    identity.relayWorkspaceId,
    identity.appWorkspaceId,
    ...identity.candidateWorkspaceIds,
  ]);

  for (const candidateWorkspaceId of candidateWorkspaceIds) {
    const integration = await getWorkspaceIntegrationByProviderAlias(
      candidateWorkspaceId,
      lookupProvider,
    );
    if (integration) {
      return { integration, candidateWorkspaceIds };
    }
  }

  return { integration: null, candidateWorkspaceIds };
}

export function resolveBackendIntegrationId(
  integration: WorkspaceIntegrationRecord,
): string {
  const candidate =
    (integration as { backendIntegrationId?: string | null })
      .backendIntegrationId ?? integration.providerConfigKey;
  return candidate ??
    (isWorkspaceIntegrationProvider(integration.provider)
      ? getProviderConfigKey(integration.provider)
      : integration.provider);
}

async function executeNotionWriteback(
  input: RelayfileWritebackInput,
  integration: WorkspaceIntegrationRecord,
): Promise<RelayfileWritebackExecutionResult> {
  let request: NotionWritebackRequest;
  try {
    request =
      input.action === "file_delete"
        ? resolveNotionDeleteRequest(input.path)
        : resolveWritebackRequest(input.path, input.content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return permanentFailure("notion", "unsupported_path", message);
  }

  const metadata: RelayfileProviderResultMetadata = {
    provider: integration.provider,
    action: request.action,
    method: request.method,
    endpoint: request.endpoint,
  };

  try {
    const response = await proxyThroughNango<NotionProxyResponseBody>({
      connectionId: integration.connectionId,
      backendIntegrationId: resolveBackendIntegrationId(integration),
      method: request.method,
      endpoint: request.endpoint,
      headers: {
        "Notion-Version": request.apiVersion ?? DEFAULT_NOTION_API_VERSION,
      },
      data: request.body,
    });

    const responseMetadata = {
      ...metadata,
      status: response.status,
      ...(extractExternalId(response.data) ? { externalId: extractExternalId(response.data) } : {}),
    } satisfies RelayfileProviderResultMetadata;

    if (response.ok) {
      return successResult("notion", responseMetadata);
    }

    const message = readMessageFromPayload(
      response.data,
      `Notion writeback failed with status ${response.status}`,
    );

    return isRetryableStatus(response.status)
      ? retryableFailure("notion", "provider_request_failed", message, responseMetadata)
      : permanentFailure("notion", "invalid_content", message, responseMetadata);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return retryableFailure("notion", "nango_proxy_failed", message, metadata);
  }
}

async function executeHubSpotWriteback(
  input: RelayfileWritebackInput,
  integration: WorkspaceIntegrationRecord,
): Promise<RelayfileWritebackExecutionResult> {
  let request: HubSpotWritebackRequest;
  try {
    request =
      input.action === "file_delete"
        ? resolveHubSpotDeleteRequest(input.path)
        : resolveHubSpotWritebackRequest(input.path, input.content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return permanentFailure("hubspot", "unsupported_path", message);
  }

  const metadata: RelayfileProviderResultMetadata = {
    provider: integration.provider,
    action: request.action,
    method: request.method,
    endpoint: request.endpoint,
  };

  try {
    const response = await proxyThroughNango<Record<string, unknown>>({
      connectionId: integration.connectionId,
      backendIntegrationId: resolveBackendIntegrationId(integration),
      method: request.method,
      endpoint: request.endpoint,
      data: request.body,
    });

    const responseMetadata = {
      ...metadata,
      status: response.status,
      ...(extractExternalId(response.data)
        ? { externalId: extractExternalId(response.data) }
        : {}),
    } satisfies RelayfileProviderResultMetadata;

    if (response.ok) {
      return successResult("hubspot", responseMetadata);
    }

    const message = readMessageFromPayload(
      response.data,
      `HubSpot writeback failed with status ${response.status}`,
    );
    return isRetryableStatus(response.status)
      ? retryableFailure(
          "hubspot",
          "provider_request_failed",
          message,
          responseMetadata,
        )
      : permanentFailure("hubspot", "invalid_content", message, responseMetadata);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return retryableFailure("hubspot", "nango_proxy_failed", message, metadata);
  }
}

async function executeGoogleCalendarWriteback(
  input: RelayfileWritebackInput,
  integration: WorkspaceIntegrationRecord,
): Promise<RelayfileWritebackExecutionResult> {
  let request: GoogleCalendarWritebackRequest;
  try {
    // Google Calendar routes create/update/delete by path within a single
    // resolver (deletes are a `.../events/{id}/delete.json` tombstone write),
    // so there is no separate delete resolver to branch on input.action.
    request = resolveGoogleCalendarWritebackRequest(input.path, input.content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return permanentFailure("google-calendar", "unsupported_path", message);
  }

  const metadata: RelayfileProviderResultMetadata = {
    provider: integration.provider,
    action: request.action,
    method: request.method,
    endpoint: request.endpoint,
  };

  try {
    const response = await proxyThroughNango<Record<string, unknown>>({
      connectionId: integration.connectionId,
      backendIntegrationId: resolveBackendIntegrationId(integration),
      method: request.method,
      endpoint: request.endpoint,
      ...(request.query ? { params: request.query } : {}),
      data: request.body,
    });

    const responseMetadata = {
      ...metadata,
      status: response.status,
      ...(extractExternalId(response.data)
        ? { externalId: extractExternalId(response.data) }
        : {}),
    } satisfies RelayfileProviderResultMetadata;

    if (response.ok) {
      return successResult("google-calendar", responseMetadata);
    }

    const message = readMessageFromPayload(
      response.data,
      `Google Calendar writeback failed with status ${response.status}`,
    );
    return isRetryableStatus(response.status)
      ? retryableFailure(
          "google-calendar",
          "provider_request_failed",
          message,
          responseMetadata,
        )
      : permanentFailure(
          "google-calendar",
          "invalid_content",
          message,
          responseMetadata,
        );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return retryableFailure(
      "google-calendar",
      "nango_proxy_failed",
      message,
      metadata,
    );
  }
}

async function executeGoogleMailWriteback(
  input: RelayfileWritebackInput,
  integration: WorkspaceIntegrationRecord,
): Promise<RelayfileWritebackExecutionResult> {
  let request: GoogleMailWritebackRequest;
  try {
    request = resolveGoogleMailWritebackRequest(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return permanentFailure("google-mail", "unsupported_path", message);
  }

  const metadata: RelayfileProviderResultMetadata = {
    provider: integration.provider,
    action: request.action,
    method: request.method,
    endpoint: request.endpoint,
  };

  try {
    const response = await proxyThroughNango<Record<string, unknown>>({
      connectionId: integration.connectionId,
      backendIntegrationId: resolveBackendIntegrationId(integration),
      method: request.method,
      endpoint: request.endpoint,
      data: request.body,
    });

    const externalId =
      extractExternalId(response.data) ??
      (isRecord(response.data) && typeof response.data.sendAsEmail === "string"
        ? response.data.sendAsEmail
        : undefined);
    const responseMetadata = {
      ...metadata,
      status: response.status,
      ...(externalId ? { externalId } : {}),
    } satisfies RelayfileProviderResultMetadata;

    if (response.ok) {
      return successResult("google-mail", responseMetadata);
    }

    const message = readMessageFromPayload(
      response.data,
      `Google Mail writeback failed with status ${response.status}`,
    );
    return isRetryableStatus(response.status)
      ? retryableFailure(
          "google-mail",
          "provider_request_failed",
          message,
          responseMetadata,
        )
      : permanentFailure(
          "google-mail",
          "invalid_content",
          message,
          responseMetadata,
        );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return retryableFailure(
      "google-mail",
      "nango_proxy_failed",
      message,
      metadata,
    );
  }
}

async function executeSlackDirectProxyWriteback(
  input: RelayfileWritebackInput,
  request: SlackWritebackRequest,
  integration: WorkspaceIntegrationRecord,
  metadata: RelayfileProviderResultMetadata,
  options?: {
    fetchImpl?: typeof fetch;
    resolveBotToken?: (workspaceId: string) => Promise<string | null>;
  },
): Promise<RelayfileWritebackExecutionResult> {
  const body = request.body;
  const channel = typeof body.channel === "string" ? body.channel : undefined;
  const threadTs = typeof body.thread_ts === "string" ? body.thread_ts : undefined;
  const text =
    typeof body.text === "string" ? body.text :
    typeof body.markdownText === "string" ? body.markdownText :
    undefined;

  if (!channel) {
    return permanentFailure(
      "slack",
      "invalid_content",
      "Slack direct-proxy writeback missing required channel in request body",
      metadata,
    );
  }

  const idempotencyKey = slackDirectProxyLogicalIdempotencyKey({
    workspaceId: integration.workspaceId,
    providerConfigKey: integration.providerConfigKey ?? "",
    connectionId: integration.connectionId ?? "",
    action: request.action,
    channel,
    ...(threadTs ? { threadTs } : {}),
    payload: body,
  });
  const claim = await claimSlackDirectProxyWriteback({
    workspaceId: integration.workspaceId,
    idempotencyKey,
    providerConfigKey: integration.providerConfigKey ?? "",
    connectionId: integration.connectionId ?? "",
    opId: input.opId,
  });
  if (!claim.claimed) {
    const record = claim.record?.status === "pending"
      ? await waitForSlackDirectProxyWritebackResult({
          workspaceId: integration.workspaceId,
          idempotencyKey,
        })
      : claim.record;
    const existing = record
      ? resultFromSlackDirectProxyIdempotencyRecord(record, metadata)
      : null;
    if (existing) {
      return existing;
    }
    return retryableFailure(
      "slack",
      "provider_request_failed",
      "Slack direct-proxy duplicate is still pending",
      metadata,
    );
  }

  const egress = createSlackConversationEgress({
    resolveBotToken: options?.resolveBotToken ?? resolveSlackConversationBotToken,
    ...(options?.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });

  try {
    const result = await egress.startStream({
      workspaceId: integration.workspaceId,
      channel,
      ...(threadTs ? { threadTs } : {}),
      ...(text ? { markdownText: text } : {}),
    });

    if (result.ok) {
      const success = successResult("slack", {
        ...metadata,
        ...(result.ts ? { externalId: result.ts } : {}),
      });
      await completeSlackDirectProxyWriteback({
        workspaceId: integration.workspaceId,
        idempotencyKey,
        status: "success",
        slackTs: result.ts ?? null,
        metadata: success.metadata,
      }).catch((error) => {
        console.warn("slack_direct_proxy_idempotency_complete_failed", {
          workspaceId: integration.workspaceId,
          opId: input.opId,
          idempotencyKey,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return success;
    }

    const errorMessage = result.errorDetail?.message ?? result.error ?? "Slack direct-proxy writeback failed";
    const errorCode = result.errorDetail?.code;
    const slackError = result.errorDetail?.slackError;
    // invalid_response = non-JSON 2xx (transient network corruption) → retryable
    const retryableCodes = new Set(["request_failed", "slack_http_error", "invalid_response"]);
    // Mirror the per-slackError retryability from normalizeSlackProxyResponse
    const retryableSlackErrors = new Set(["ratelimited", "rate_limited", "service_unavailable"]);
    const retryable =
      (errorCode !== undefined && retryableCodes.has(errorCode)) ||
      (slackError !== undefined && retryableSlackErrors.has(slackError));
    const failure = retryable
      ? retryableFailure("slack", "provider_request_failed", errorMessage, metadata)
      : permanentFailure("slack", "invalid_content", errorMessage, metadata);
    if (failure.outcome === "permanent_failure") {
      await completeSlackDirectProxyWriteback({
        workspaceId: integration.workspaceId,
        idempotencyKey,
        status: "permanent_failure",
        metadata,
        errorCode: failure.error.code,
        errorMessage: failure.error.message,
      }).catch((error) => {
        console.warn("slack_direct_proxy_idempotency_complete_failed", {
          workspaceId: integration.workspaceId,
          opId: input.opId,
          idempotencyKey,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } else {
      await releaseSlackDirectProxyWritebackClaim({
        workspaceId: integration.workspaceId,
        idempotencyKey,
      }).catch(() => undefined);
    }
    return failure;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await releaseSlackDirectProxyWritebackClaim({
      workspaceId: integration.workspaceId,
      idempotencyKey,
    }).catch(() => undefined);
    return retryableFailure("slack", "provider_request_failed", message, metadata);
  }
}

async function executeSlackDirectReactionWriteback(
  request: SlackWritebackRequest,
  integration: WorkspaceIntegrationRecord,
  metadata: RelayfileProviderResultMetadata,
  options?: {
    fetchImpl?: typeof fetch;
    resolveBotToken?: (workspaceId: string) => Promise<string | null>;
  },
): Promise<RelayfileWritebackExecutionResult> {
  const body = request.body;
  const channel = typeof body.channel === "string" ? body.channel : undefined;
  const timestamp = typeof body.timestamp === "string" ? body.timestamp : undefined;
  const name = typeof body.name === "string" ? body.name : undefined;

  if (!channel || !timestamp || !name) {
    return permanentFailure(
      "slack",
      "invalid_content",
      "Slack reaction direct-proxy missing required channel, timestamp, or name",
      metadata,
    );
  }

  const resolveToken = options?.resolveBotToken ?? resolveSlackConversationBotToken;
  const token = await resolveToken(integration.workspaceId);
  if (!token) {
    return permanentFailure("slack", "invalid_content", "Could not resolve Slack bot token for reaction", metadata);
  }

  const fetchImpl = options?.fetchImpl ?? fetch;
  // endpoint is /api/reactions.add or /api/reactions.remove
  const url = `https://slack.com/api${request.endpoint.startsWith("/api/") ? request.endpoint.slice(4) : request.endpoint}`;

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel, timestamp, name }),
    });

    let payload: Record<string, unknown>;
    try {
      payload = await res.json() as Record<string, unknown>;
    } catch {
      return res.ok
        ? retryableFailure("slack", "provider_request_failed", "Slack reactions API returned non-JSON response", metadata)
        : retryableFailure("slack", "provider_request_failed", `Slack reactions API failed with status ${res.status}`, metadata);
    }

    if (!res.ok) {
      return retryableFailure("slack", "provider_request_failed", `Slack reactions API failed with status ${res.status}`, metadata);
    }

    if (payload.ok === true) {
      return successResult("slack", metadata);
    }

    const slackError = typeof payload.error === "string" ? payload.error : "unknown";
    const retryableSlackErrors = new Set(["ratelimited", "rate_limited", "service_unavailable"]);
    return retryableSlackErrors.has(slackError)
      ? retryableFailure("slack", "provider_request_failed", `Slack reactions API error: ${slackError}`, metadata)
      : permanentFailure("slack", "invalid_content", `Slack reactions API error: ${slackError}`, metadata);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return retryableFailure("slack", "provider_request_failed", message, metadata);
  }
}

async function executeSlackDirectDmWriteback(
  input: RelayfileWritebackInput,
  request: SlackDirectMessageWritebackRequest,
  integration: WorkspaceIntegrationRecord,
  metadata: RelayfileProviderResultMetadata,
  options?: {
    fetchImpl?: typeof fetch;
    resolveBotToken?: (workspaceId: string) => Promise<string | null>;
  },
): Promise<RelayfileWritebackExecutionResult> {
  const resolveToken = options?.resolveBotToken ?? resolveSlackConversationBotToken;
  const token = await resolveToken(integration.workspaceId);
  if (!token) {
    return permanentFailure("slack", "invalid_content", "Could not resolve Slack bot token for DM", metadata);
  }

  const fetchImpl = options?.fetchImpl ?? fetch;
  const retryableSlackErrors = new Set(["ratelimited", "rate_limited", "service_unavailable"]);

  // Step 1: conversations.open to resolve the DM channel ID
  let openPayload: Record<string, unknown>;
  try {
    const openRes = await fetchImpl("https://slack.com/api/conversations.open", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ users: request.body.users, return_im: true }),
    });

    try {
      openPayload = (await openRes.json()) as Record<string, unknown>;
    } catch {
      return openRes.ok
        ? retryableFailure("slack", "provider_request_failed", "Non-JSON response from conversations.open", metadata)
        : retryableFailure("slack", "provider_request_failed", `conversations.open failed with status ${openRes.status}`, metadata);
    }

    if (!openRes.ok) {
      return retryableFailure("slack", "provider_request_failed", `conversations.open failed with status ${openRes.status}`, metadata);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return retryableFailure("slack", "provider_request_failed", message, metadata);
  }

  if (openPayload.ok !== true) {
    const slackError = typeof openPayload.error === "string" ? openPayload.error : "unknown";
    return retryableSlackErrors.has(slackError)
      ? retryableFailure("slack", "provider_request_failed", `conversations.open error: ${slackError}`, metadata)
      : permanentFailure("slack", "invalid_content", `conversations.open error: ${slackError}`, metadata);
  }

  const channel = readSlackConversationId(openPayload);
  if (!channel) {
    return permanentFailure("slack", "invalid_content", "conversations.open succeeded but no channel ID returned", metadata);
  }

  const idempotencyKey = slackDirectProxyLogicalIdempotencyKey({
    workspaceId: integration.workspaceId,
    providerConfigKey: integration.providerConfigKey ?? "",
    connectionId: integration.connectionId ?? "",
    action: request.action,
    channel,
    payload: request.body.message,
  });
  const claim = await claimSlackDirectProxyWriteback({
    workspaceId: integration.workspaceId,
    idempotencyKey,
    providerConfigKey: integration.providerConfigKey ?? "",
    connectionId: integration.connectionId ?? "",
    opId: input.opId,
  });
  if (!claim.claimed) {
    const record = claim.record?.status === "pending"
      ? await waitForSlackDirectProxyWritebackResult({
          workspaceId: integration.workspaceId,
          idempotencyKey,
        })
      : claim.record;
    const existing = record
      ? resultFromSlackDirectProxyIdempotencyRecord(record, metadata)
      : null;
    if (existing) {
      return existing;
    }
    return retryableFailure(
      "slack",
      "provider_request_failed",
      "Slack direct-proxy duplicate is still pending",
      metadata,
    );
  }

  // Step 2: chat.postMessage to the resolved DM channel
  let postPayload: Record<string, unknown>;
  try {
    const postRes = await fetchImpl("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel, ...request.body.message }),
    });

    try {
      postPayload = (await postRes.json()) as Record<string, unknown>;
    } catch {
      await releaseSlackDirectProxyWritebackClaim({
        workspaceId: integration.workspaceId,
        idempotencyKey,
      }).catch(() => undefined);
      return postRes.ok
        ? retryableFailure("slack", "provider_request_failed", "Non-JSON response from chat.postMessage (DM)", metadata)
        : retryableFailure("slack", "provider_request_failed", `chat.postMessage (DM) failed with status ${postRes.status}`, metadata);
    }

    if (!postRes.ok) {
      await releaseSlackDirectProxyWritebackClaim({
        workspaceId: integration.workspaceId,
        idempotencyKey,
      }).catch(() => undefined);
      return retryableFailure("slack", "provider_request_failed", `chat.postMessage (DM) failed with status ${postRes.status}`, metadata);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await releaseSlackDirectProxyWritebackClaim({
      workspaceId: integration.workspaceId,
      idempotencyKey,
    }).catch(() => undefined);
    return retryableFailure("slack", "provider_request_failed", message, metadata);
  }

  if (postPayload.ok !== true) {
    const slackError = typeof postPayload.error === "string" ? postPayload.error : "unknown";
    const failure = retryableSlackErrors.has(slackError)
      ? retryableFailure("slack", "provider_request_failed", `chat.postMessage (DM) error: ${slackError}`, metadata)
      : permanentFailure("slack", "invalid_content", `chat.postMessage (DM) error: ${slackError}`, metadata);
    if (failure.outcome === "permanent_failure") {
      await completeSlackDirectProxyWriteback({
        workspaceId: integration.workspaceId,
        idempotencyKey,
        status: "permanent_failure",
        metadata,
        errorCode: failure.error.code,
        errorMessage: failure.error.message,
      }).catch((error) => {
        console.warn("slack_direct_proxy_idempotency_complete_failed", {
          workspaceId: integration.workspaceId,
          opId: input.opId,
          idempotencyKey,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } else {
      await releaseSlackDirectProxyWritebackClaim({
        workspaceId: integration.workspaceId,
        idempotencyKey,
      }).catch(() => undefined);
    }
    return failure;
  }

  const externalId = typeof postPayload.ts === "string" ? postPayload.ts : undefined;
  const success = successResult("slack", { ...metadata, ...(externalId ? { externalId } : {}) });
  await completeSlackDirectProxyWriteback({
    workspaceId: integration.workspaceId,
    idempotencyKey,
    status: "success",
    slackTs: externalId ?? null,
    metadata: success.metadata,
  }).catch((error) => {
    console.warn("slack_direct_proxy_idempotency_complete_failed", {
      workspaceId: integration.workspaceId,
      opId: input.opId,
      idempotencyKey,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return success;
}

async function executeSlackWriteback(
  input: RelayfileWritebackInput,
  integration: WorkspaceIntegrationRecord,
  options?: {
    fetchImpl?: typeof fetch;
    resolveBotToken?: (workspaceId: string) => Promise<string | null>;
  },
): Promise<RelayfileWritebackExecutionResult> {
  let request: SlackWritebackRequest | SlackDirectMessageWritebackRequest;
  try {
    request =
      input.action === "file_delete"
        ? resolveSlackDeleteRequest(input.path)
        : resolveSlackWritebackRequest(input.path, input.content);
  } catch (error) {
    if (input.action !== "file_delete") {
      try {
        request = resolveSlackDirectMessageWriteback(input.path, input.content);
      } catch (fallbackError) {
        const message =
          fallbackError instanceof Error
            ? fallbackError.message
            : error instanceof Error
              ? error.message
              : String(error);
        return permanentFailure("slack", "unsupported_path", message);
      }
    } else {
      const message = error instanceof Error ? error.message : String(error);
      return permanentFailure("slack", "unsupported_path", message);
    }
  }

  const metadata: RelayfileProviderResultMetadata = {
    provider: integration.provider,
    action: request.action,
    method: request.method,
    endpoint: request.endpoint,
  };

  if (isSlackDirectMessageWritebackRequest(request)) {
    const dmBackend = resolveWritebackDispatchBackend({
      provider: "slack",
      action: request.action,
      integration,
    });
    if (dmBackend === "direct-proxy") {
      return executeSlackDirectDmWriteback(input, request, integration, metadata, options);
    }
    return executeSlackDirectMessageWriteback(request, integration, metadata);
  }

  // Server-side threading: a parent-dependency writeback carries the parent op's
  // delivered provider object id (input.parentExternalId). For a Slack
  // chat.postMessage that id is the thread root — inject it as thread_ts so the
  // reply threads under the message the cloud just posted. Mirrors the cf-path
  // provider (relayfile-cloud slack.ts); the bridge dispatch path previously
  // dropped parentExternalId, so bridged Slack replies posted top-level.
  if (
    input.parentExternalId &&
    request.endpoint === "/api/chat.postMessage" &&
    request.method.toUpperCase() === "POST" &&
    isRecord(request.body)
  ) {
    (request.body as Record<string, unknown>).thread_ts = input.parentExternalId;
  }

  const backend = resolveWritebackDispatchBackend({
    provider: "slack",
    action: request.action,
    integration,
  });

  if (backend === "direct-proxy") {
    if (request.action === "add_reaction" || request.action === "remove_reaction") {
      return executeSlackDirectReactionWriteback(request, integration, metadata, options);
    }
    return executeSlackDirectProxyWriteback(input, request, integration, metadata, options);
  }

  // The adapter emits `/api/chat.postMessage` (matching Slack's actual Web
  // API path), but the cloud's Slack-via-Nango convention sends the bare
  // method path (`/chat.postMessage`) and lets Nango's proxy prepend `/api`.
  // Without this strip the docker mock-nango forwards
  // /api/api/chat.postMessage and 404s every Slack writeback. Confirmed
  // against docker/e2e/mock-nango/server.js:159-161 and
  // packages/web/lib/integrations/nango-slack.ts.
  const proxyEndpoint = request.endpoint.startsWith("/api/")
    ? request.endpoint.slice("/api".length)
    : request.endpoint;

  const responseMetadataBase: RelayfileProviderResultMetadata = {
    ...metadata,
    endpoint: proxyEndpoint,
  };

  try {
    const response = await proxyThroughNango<Record<string, unknown>>({
      connectionId: integration.connectionId,
      backendIntegrationId: resolveBackendIntegrationId(integration),
      method: request.method,
      endpoint: proxyEndpoint,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      data: request.body,
    });

    return normalizeSlackProxyResponse(
      response,
      request.action,
      request.body,
      responseMetadataBase,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return retryableFailure("slack", "nango_proxy_failed", message, responseMetadataBase);
  }
}

type TelegramWritebackRequest = {
  action:
    | "send_message"
    | "set_message_reaction"
    | "answer_callback_query"
    | "answer_inline_query"
    | "set_my_commands"
    | "set_chat_menu_button";
  method: "POST";
  endpoint:
    | "/sendMessage"
    | "/sendRichMessage"
    | "/sendPhoto"
    | "/sendAudio"
    | "/sendDocument"
    | "/sendVideo"
    | "/sendAnimation"
    | "/sendVoice"
    | "/sendVideoNote"
    | "/sendMediaGroup"
    | "/sendLocation"
    | "/sendVenue"
    | "/sendContact"
    | "/sendPoll"
    | "/sendChecklist"
    | "/sendDice"
    | "/setMessageReaction"
    | "/answerCallbackQuery"
    | "/answerInlineQuery"
    | "/setMyCommands"
    | "/setChatMenuButton";
  body: Record<string, unknown>;
};

async function executeTelegramWriteback(
  input: RelayfileWritebackInput,
  integration: WorkspaceIntegrationRecord,
): Promise<RelayfileWritebackExecutionResult> {
  if (input.action === "file_delete") {
    return permanentFailure(
      "telegram",
      "unsupported_path",
      "Telegram Relayfile writeback supports create/upsert operation drafts, not file deletes",
    );
  }

  let request: TelegramWritebackRequest;
  try {
    request = resolveTelegramWritebackRequest(input.path, input.content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return permanentFailure("telegram", "unsupported_path", message);
  }

  const backend = resolveWritebackDispatchBackend({
    provider: "telegram",
    action: request.action,
    integration,
  });
  const metadata: RelayfileProviderResultMetadata = {
    provider: integration.provider,
    action: request.action,
    method: request.method,
    endpoint: request.endpoint,
  };

  if (backend !== "direct-proxy") {
    return permanentFailure(
      "telegram",
      "unsupported_path",
      "Telegram writebacks must use Cloud direct-proxy dispatch",
      metadata,
    );
  }

  try {
    const response = await proxyThroughNango<Record<string, unknown>>({
      connectionId: integration.connectionId,
      backendIntegrationId: resolveBackendIntegrationId(integration),
      method: request.method,
      endpoint: request.endpoint,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      data: request.body,
    });

    return normalizeTelegramProxyResponse(response, request, metadata);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return retryableFailure("telegram", "nango_proxy_failed", message, metadata);
  }
}

function resolveTelegramWritebackRequest(
  path: string,
  content: string,
): TelegramWritebackRequest {
  const messageMatch = path.match(/^\/telegram\/chats\/([^/]+)\/messages(?:\/[^/]+(?:\.json)?)?$/u);
  if (messageMatch?.[1]) {
    const body = parseTelegramWritebackBody(content, { allowPlainText: true });
    const chatId = decodeTelegramIdPathSegment(messageMatch[1], "chat");
    if (body.chat_id === undefined) {
      body.chat_id = chatId;
    }
    const endpoint = resolveTelegramMessageEndpoint(body);
    return {
      action: "send_message",
      method: "POST",
      endpoint,
      body,
    };
  }

  const reactionMatch = path.match(
    /^\/telegram\/chats\/([^/]+)\/messages\/([^/]+)\/reactions(?:\/[^/]+(?:\.json)?)?$/u,
  );
  if (reactionMatch?.[1] && reactionMatch[2]) {
    const body = parseTelegramWritebackBody(content);
    const chatId = decodeTelegramIdPathSegment(reactionMatch[1], "chat");
    const messageId = readTelegramIntegerPathSegment(reactionMatch[2], "message");
    if (!Array.isArray(body.reaction)) {
      throw new Error("Telegram reaction writeback requires `reaction` array");
    }
    return {
      action: "set_message_reaction",
      method: "POST",
      endpoint: "/setMessageReaction",
      body: {
        ...body,
        chat_id: body.chat_id ?? chatId,
        message_id: body.message_id ?? messageId,
      },
    };
  }

  const callbackMatch = path.match(/^\/telegram\/callback-queries(?:\/([^/]+)(?:\.json)?)?$/u);
  if (callbackMatch) {
    const body = parseTelegramWritebackBody(content);
    const fallbackId = callbackMatch[1]
      ? decodeTelegramIdPathSegment(callbackMatch[1], "callback query")
      : undefined;
    const callbackQueryId =
      typeof body.callback_query_id === "string" && body.callback_query_id.trim().length > 0
        ? body.callback_query_id
        : fallbackId;
    if (!callbackQueryId) {
      throw new Error("Telegram callback query writeback requires `callback_query_id`");
    }
    return {
      action: "answer_callback_query",
      method: "POST",
      endpoint: "/answerCallbackQuery",
      body: {
        ...body,
        callback_query_id: callbackQueryId,
      },
    };
  }

  const inlineMatch = path.match(/^\/telegram\/inline-queries(?:\/([^/]+)(?:\.json)?)?$/u);
  if (inlineMatch) {
    const body = parseTelegramWritebackBody(content);
    const fallbackId = inlineMatch[1]
      ? decodeTelegramIdPathSegment(inlineMatch[1], "inline query")
      : undefined;
    const inlineQueryId =
      typeof body.inline_query_id === "string" && body.inline_query_id.trim().length > 0
        ? body.inline_query_id
        : fallbackId;
    if (!inlineQueryId) {
      throw new Error("Telegram inline query writeback requires `inline_query_id`");
    }
    if (!Array.isArray(body.results)) {
      throw new Error("Telegram inline query writeback requires `results` array");
    }
    return {
      action: "answer_inline_query",
      method: "POST",
      endpoint: "/answerInlineQuery",
      body: {
        ...body,
        inline_query_id: inlineQueryId,
      },
    };
  }

  if (/^\/telegram\/bot\/commands(?:\/[^/]+(?:\.json)?)?$/u.test(path)) {
    const body = parseTelegramWritebackBody(content);
    if (!Array.isArray(body.commands)) {
      throw new Error("Telegram bot commands writeback requires `commands` array");
    }
    return {
      action: "set_my_commands",
      method: "POST",
      endpoint: "/setMyCommands",
      body,
    };
  }

  if (/^\/telegram\/bot\/menu-button(?:\/[^/]+(?:\.json)?)?$/u.test(path)) {
    const body = parseTelegramWritebackBody(content);
    if (!isRecord(body.menu_button)) {
      throw new Error("Telegram menu button writeback requires `menu_button` object");
    }
    return {
      action: "set_chat_menu_button",
      method: "POST",
      endpoint: "/setChatMenuButton",
      body,
    };
  }

  throw new Error(`No Telegram writeback rule matched ${path}`);
}

function resolveTelegramMessageEndpoint(
  body: Record<string, unknown>,
): TelegramWritebackRequest["endpoint"] {
  const hasNonEmptyText = typeof body.text === "string" && body.text.trim().length > 0;
  if (hasNonEmptyText) return "/sendMessage";
  if (body.rich_message !== undefined) return "/sendRichMessage";
  if (body.photo !== undefined) return "/sendPhoto";
  if (body.audio !== undefined) return "/sendAudio";
  if (body.document !== undefined) return "/sendDocument";
  if (body.video !== undefined) return "/sendVideo";
  if (body.animation !== undefined) return "/sendAnimation";
  if (body.voice !== undefined) return "/sendVoice";
  if (body.video_note !== undefined) return "/sendVideoNote";
  if (body.media !== undefined) return "/sendMediaGroup";
  if (body.latitude !== undefined && body.longitude !== undefined && body.title !== undefined && body.address !== undefined) return "/sendVenue";
  if (body.latitude !== undefined && body.longitude !== undefined) return "/sendLocation";
  if (body.phone_number !== undefined && body.first_name !== undefined) return "/sendContact";
  if (body.question !== undefined && body.options !== undefined) return "/sendPoll";
  if (body.checklist !== undefined) return "/sendChecklist";
  if (body.emoji !== undefined) return "/sendDice";

  throw new Error(
    "Telegram message writeback requires `text`, `rich_message`, `photo`, `audio`, `document`, `video`, `animation`, `voice`, `video_note`, `media`, location or venue fields, contact fields, poll fields, `checklist`, or `emoji`",
  );
}

function parseTelegramWritebackBody(
  content: string,
  options?: { allowPlainText?: boolean },
): Record<string, unknown> {
  const parsed = safeParseJson(content);
  if (typeof parsed === "string") {
    if (!options?.allowPlainText || parsed.trim().length === 0) {
      throw new Error("Telegram writeback expects a JSON object");
    }
    return { text: parsed.trim() };
  }
  if (!isRecord(parsed)) {
    throw new Error("Telegram writeback expects a JSON object");
  }

  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (TELEGRAM_READ_ONLY_FIELDS.has(key)) {
      throw new Error(`Telegram writeback payload includes read-only field ${key}`);
    }
    if (key !== "idempotencyKey") {
      body[key] = value;
    }
  }
  return body;
}

function decodeTelegramIdPathSegment(encoded: string, field: string): string {
  const decoded = decodePathSegment(encoded, field);
  const canonicalJoiner = decoded.indexOf("__");
  return canonicalJoiner > 0 ? decoded.slice(0, canonicalJoiner) : decoded;
}

function readTelegramIntegerPathSegment(encoded: string, field: string): number {
  const decoded = decodeTelegramIdPathSegment(encoded, field);
  const value = Number(decoded);
  if (!Number.isInteger(value)) {
    throw new Error(`Telegram ${field} id must be an integer`);
  }
  return value;
}

function normalizeTelegramProxyResponse(
  response: NangoProxyResult<Record<string, unknown>>,
  request: TelegramWritebackRequest,
  metadata: RelayfileProviderResultMetadata,
): RelayfileWritebackExecutionResult {
  const body = isRecord(response.data) ? response.data : null;
  const telegramOk = body?.ok === true;
  const description =
    typeof body?.description === "string" ? body.description :
    typeof body?.error === "string" ? body.error :
    undefined;
  const externalId = extractTelegramExternalId(body, request);
  const responseMetadata = {
    ...metadata,
    status: response.status,
    ...(externalId ? { externalId } : {}),
  } satisfies RelayfileProviderResultMetadata;

  if (response.ok && telegramOk) {
    return successResult("telegram", responseMetadata);
  }

  const message =
    description ??
    readMessageFromPayload(
      response.data,
      `Telegram writeback failed with status ${response.status}`,
    );
  const retryable =
    isRetryableStatus(response.status) ||
    response.status >= 500 ||
    isTelegramRetryAfter(body);

  return retryable
    ? retryableFailure("telegram", "provider_request_failed", message, responseMetadata)
    : permanentFailure("telegram", "invalid_content", message, responseMetadata);
}

function extractTelegramExternalId(
  body: Record<string, unknown> | null,
  request: TelegramWritebackRequest,
): string | undefined {
  if (!body || body.ok !== true) {
    return undefined;
  }
  const result = body.result;
  if (isRecord(result)) {
    const messageId = result.message_id;
    if (typeof messageId === "string" || typeof messageId === "number") {
      return String(messageId);
    }
  } else if (Array.isArray(result)) {
    const first = result.find(isRecord);
    const messageId = first?.message_id;
    if (typeof messageId === "string" || typeof messageId === "number") {
      return String(messageId);
    }
  }
  if (request.action === "set_message_reaction") {
    const messageId = request.body.message_id;
    return typeof messageId === "string" || typeof messageId === "number"
      ? String(messageId)
      : undefined;
  }
  return undefined;
}

function isTelegramRetryAfter(body: Record<string, unknown> | null): boolean {
  if (!body || !isRecord(body.parameters)) {
    return false;
  }
  return typeof body.parameters.retry_after === "number";
}

function resolveSlackDirectMessageWriteback(
  path: string,
  content: string,
): SlackDirectMessageWritebackRequest {
  const match = path.match(/^\/slack\/users\/([^/]+)\/messages\/[^/]+\.json$/);
  if (!match?.[1]) {
    throw new Error(`No Slack writeback rule matched ${path}`);
  }

  const parsed = safeParseJson(content);
  let message: Record<string, unknown>;
  if (typeof parsed === "string") {
    if (!parsed.trim()) {
      throw new Error("Slack direct message writeback requires a non-empty body");
    }
    message = { text: parsed.trim() };
  } else if (isRecord(parsed)) {
    rejectReadOnlySlackFields(parsed);
    const text = readString(parsed, "text");
    const blocks = Array.isArray(parsed.blocks) ? parsed.blocks : undefined;
    const attachments = Array.isArray(parsed.attachments) ? parsed.attachments : undefined;
    if (!text && !blocks && !attachments) {
      throw new Error(
        "Slack direct message writeback requires `text`, `blocks`, or `attachments`",
      );
    }
    message = {};
    if (text) message.text = text;
    if (blocks) message.blocks = blocks;
    if (attachments) message.attachments = attachments;
    for (const key of ["username", "icon_emoji", "icon_url"] as const) {
      const value = readString(parsed, key);
      if (value) message[key] = value;
    }
    for (const key of ["unfurl_links", "unfurl_media", "mrkdwn"] as const) {
      const value = parsed[key];
      if (typeof value === "boolean") message[key] = value;
    }
  } else {
    throw new Error("Slack direct message writeback expects a JSON object or plain string");
  }

  return {
    action: "post_dm",
    method: "POST",
    endpoint: "/api/conversations.open",
    body: {
      users: decodePathSegment(match[1], "user"),
      return_im: true,
      message,
    },
  };
}

function rejectReadOnlySlackFields(payload: Record<string, unknown>): void {
  for (const key of Object.keys(payload)) {
    if (SLACK_READ_ONLY_FIELDS.has(key)) {
      throw new Error(`Slack writeback payload includes read-only field ${key}`);
    }
  }
}

function readSlackConversationId(payload: Record<string, unknown> | null): string | undefined {
  if (!payload) return undefined;
  if (typeof payload.channel === "string") return payload.channel;
  if (isRecord(payload.channel) && typeof payload.channel.id === "string") {
    return payload.channel.id;
  }
  return undefined;
}

function safeParseJson(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return content;
  }
}

async function executeSlackDirectMessageWriteback(
  request: SlackDirectMessageWritebackRequest,
  integration: WorkspaceIntegrationRecord,
  metadata: RelayfileProviderResultMetadata,
): Promise<RelayfileWritebackExecutionResult> {
  const backendIntegrationId = resolveBackendIntegrationId(integration);
  const openEndpoint = "/conversations.open";
  const postEndpoint = "/chat.postMessage";
  const baseMetadata = { ...metadata, endpoint: openEndpoint };

  try {
    const openResponse = await proxyThroughNango<Record<string, unknown>>({
      connectionId: integration.connectionId,
      backendIntegrationId,
      method: request.method,
      endpoint: openEndpoint,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      data: { users: request.body.users, return_im: true },
    });

    const openBody = isRecord(openResponse.data) ? openResponse.data : null;
    const openOk = openResponse.ok && openBody?.ok === true;
    const channel = readSlackConversationId(openBody);
    if (!openOk) {
      return normalizeSlackProxyResponse(openResponse, request.action, request.body, baseMetadata);
    }
    if (!channel) {
      return permanentFailure(
        "slack",
        "invalid_content",
        "Slack conversations.open succeeded but did not return a channel id",
        { ...baseMetadata, status: openResponse.status },
      );
    }

    const response = await proxyThroughNango<Record<string, unknown>>({
      connectionId: integration.connectionId,
      backendIntegrationId,
      method: "POST",
      endpoint: postEndpoint,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      data: { ...request.body.message, channel },
    });

    return normalizeSlackProxyResponse(response, request.action, request.body.message, {
      ...metadata,
      endpoint: postEndpoint,
      status: response.status,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return retryableFailure("slack", "nango_proxy_failed", message, baseMetadata);
  }
}

function normalizeSlackProxyResponse(
  response: NangoProxyResult<Record<string, unknown>>,
  action: string,
  requestBody: Record<string, unknown>,
  metadata: RelayfileProviderResultMetadata,
): RelayfileWritebackExecutionResult {
  const body = isRecord(response.data) ? response.data : null;
  const slackOk = body?.ok === true;
  const slackError = typeof body?.error === "string" ? (body.error as string) : undefined;
  const externalId = (() => {
    if (!slackOk) return undefined;
    if (typeof body?.ts === "string") return body.ts as string;
    if (action === "add_reaction" && isRecord(requestBody)) {
      const requestTs = requestBody.timestamp;
      return typeof requestTs === "string" ? requestTs : undefined;
    }
    return undefined;
  })();

  const responseMetadata = {
    ...metadata,
    status: response.status,
    ...(externalId ? { externalId } : {}),
    ...(slackError ? { slackError } : {}),
  } satisfies RelayfileProviderResultMetadata;

  if (response.ok && slackOk) {
    return successResult("slack", responseMetadata);
  }

  const message =
    slackError ??
    readMessageFromPayload(
      response.data,
      `Slack writeback failed with status ${response.status}`,
    );

  const slackRetryableErrors = new Set([
    "ratelimited",
    "rate_limited",
    "service_unavailable",
    "internal_error",
    "fatal_error",
    "request_timeout",
  ]);
  const retryable =
    isRetryableStatus(response.status) ||
    response.status >= 500 ||
    (slackError !== undefined && slackRetryableErrors.has(slackError));

  return retryable
    ? retryableFailure("slack", "provider_request_failed", message, responseMetadata)
    : permanentFailure("slack", "invalid_content", message, responseMetadata);
}

async function executeLinearWriteback(
  input: RelayfileWritebackInput,
  integration: WorkspaceIntegrationRecord,
): Promise<RelayfileWritebackExecutionResult> {
  let request: LinearWritebackRequest;
  try {
    request =
      input.action === "file_delete"
        ? resolveLinearDeleteRequest(input.path)
        : resolveLinearWritebackRequest(input.path, input.content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return permanentFailure("linear", "unsupported_path", message);
  }

  const metadata: RelayfileProviderResultMetadata = {
    provider: integration.provider,
    action: request.action,
    method: request.method,
    endpoint: request.endpoint,
  };

  try {
    const response = await proxyThroughNango<Record<string, unknown>>({
      connectionId: integration.connectionId,
      backendIntegrationId: resolveBackendIntegrationId(integration),
      method: request.method,
      endpoint: request.endpoint,
      data: request.body,
    });

    const externalId =
      extractLinearExternalId(response.data, request.action) ??
      extractLinearRequestExternalId(request);
    const linearErrors = extractLinearGraphQLErrors(response.data);
    const mutationOutcome = extractLinearMutationOutcome(response.data, request.action);

    const responseMetadata = {
      ...metadata,
      status: response.status,
      ...(externalId ? { externalId } : {}),
    } satisfies RelayfileProviderResultMetadata;

    // Linear's GraphQL endpoint returns 200 even on rejected mutations. Two
    // failure shapes the cloud must handle distinctly:
    //   1. Top-level `errors` array — schema validation, auth, or rate-limit
    //      style failures.
    //   2. Mutation payload `success: false` — the mutation was accepted by
    //      the schema but rejected at the business layer (e.g. team mismatch,
    //      missing scopes). The payload may include no `errors` at all, so
    //      relying on errors[] alone would silently ACK a non-create.
    if (response.ok && !linearErrors && mutationOutcome.success !== false) {
      return successResult("linear", responseMetadata);
    }

    const message =
      linearErrors ??
      mutationOutcome.message ??
      readMessageFromPayload(
        response.data,
        `Linear writeback failed with status ${response.status}`,
      );

    return isRetryableStatus(response.status)
      ? retryableFailure("linear", "provider_request_failed", message, responseMetadata)
      : permanentFailure("linear", "invalid_content", message, responseMetadata);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return retryableFailure("linear", "nango_proxy_failed", message, metadata);
  }
}

async function executeJiraWriteback(
  input: RelayfileWritebackInput,
  integration: WorkspaceIntegrationRecord,
): Promise<RelayfileWritebackExecutionResult> {
  let request: JiraWritebackRequest;
  try {
    rejectEncodedPathSeparators(input.path, "Jira path segment");
    request =
      input.action === "file_delete"
        ? resolveJiraDeleteRequest(input.path)
        : resolveJiraWritebackRequest(input.path, input.content);
  } catch (error) {
    if (input.action !== "file_delete") {
      try {
        request = resolveJiraTransitionWriteback(input.path, input.content);
      } catch (fallbackError) {
        const message =
          fallbackError instanceof Error
            ? fallbackError.message
            : error instanceof Error
              ? error.message
              : String(error);
        return permanentFailure("jira", "unsupported_path", message);
      }
    } else {
      const message = error instanceof Error ? error.message : String(error);
      return permanentFailure("jira", "unsupported_path", message);
    }
  }

  const proxyEndpointResult = toJiraNangoProxyEndpoint(request.endpoint, integration);
  const metadata: RelayfileProviderResultMetadata = {
    provider: integration.provider,
    action: request.action,
    method: request.method,
    endpoint:
      proxyEndpointResult.ok
        ? proxyEndpointResult.endpoint
        : request.endpoint,
  };

  if (!proxyEndpointResult.ok) {
    return permanentFailure("jira", "integration_not_found", proxyEndpointResult.error, metadata);
  }

  try {
    const response = await proxyThroughNango<Record<string, unknown>>({
      connectionId: integration.connectionId,
      backendIntegrationId: resolveBackendIntegrationId(integration),
      method: request.method,
      endpoint: proxyEndpointResult.endpoint,
      ...(request.body ? { headers: { "Content-Type": "application/json; charset=utf-8" } } : {}),
      data: request.body,
    });

    const externalId = extractJiraExternalId(response.data);
    const responseMetadata = {
      ...metadata,
      status: response.status,
      ...(externalId ? { externalId } : {}),
    } satisfies RelayfileProviderResultMetadata;

    if (response.ok) {
      return successResult("jira", responseMetadata);
    }

    const message = readMessageFromPayload(
      response.data,
      `Jira writeback failed with status ${response.status}`,
    );

    return isRetryableStatus(response.status)
      ? retryableFailure("jira", "provider_request_failed", message, responseMetadata)
      : permanentFailure("jira", "invalid_content", message, responseMetadata);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return retryableFailure("jira", "nango_proxy_failed", message, metadata);
  }
}

async function executeConfluenceWriteback(
  input: RelayfileWritebackInput,
  integration: WorkspaceIntegrationRecord,
): Promise<RelayfileWritebackExecutionResult> {
  let request: ConfluenceWritebackRequest;
  try {
    request =
      input.action === "file_delete"
        ? resolveConfluenceDeleteRequest(input.path)
        : resolveConfluenceWritebackRequest(input.path, input.content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return permanentFailure("confluence", "unsupported_path", message);
  }

  // Confluence v2 POST /pages requires a numeric spaceId, but the relayfile path
  // only carries the space *key*. When a create resolves to a key-based spaceId,
  // resolve the numeric id via the API and re-resolve with it injected (the
  // adapter prefers an explicit payload spaceId over the path-derived key).
  if (request.action === "create_page") {
    const sid = (request.body as Record<string, unknown> | undefined)?.spaceId;
    if (typeof sid === "string" && sid && !/^\d+$/.test(sid)) {
      const numericId = await resolveConfluenceNumericSpaceId(sid, integration);
      if (numericId) {
        try {
          request = resolveConfluenceWritebackRequest(
            input.path,
            injectSpaceId(input.content, numericId),
          );
        } catch {
          // Keep the original (key-based) request if re-resolution fails.
        }
      }
    }
  }

  const proxyEndpointResult = toConfluenceNangoProxyEndpoint(
    request.endpoint,
    integration,
  );
  const metadata: RelayfileProviderResultMetadata = {
    provider: integration.provider,
    action: request.action,
    method: request.method,
    endpoint: proxyEndpointResult.ok
      ? proxyEndpointResult.endpoint
      : request.endpoint,
  };

  if (!proxyEndpointResult.ok) {
    return permanentFailure(
      "confluence",
      "integration_not_found",
      proxyEndpointResult.error,
      metadata,
    );
  }

  try {
    const response = await proxyThroughNango<Record<string, unknown>>({
      connectionId: integration.connectionId,
      backendIntegrationId: resolveBackendIntegrationId(integration),
      method: request.method,
      endpoint: proxyEndpointResult.endpoint,
      ...(request.body ? { headers: { "Content-Type": "application/json; charset=utf-8" } } : {}),
      data: request.body,
    });

    const externalId = extractExternalId(response.data);
    const responseMetadata = {
      ...metadata,
      status: response.status,
      ...(externalId ? { externalId } : {}),
    } satisfies RelayfileProviderResultMetadata;

    if (response.ok) {
      return successResult("confluence", responseMetadata);
    }

    const message = readMessageFromPayload(
      response.data,
      `Confluence writeback failed with status ${response.status}`,
    );

    return isRetryableStatus(response.status)
      ? retryableFailure("confluence", "provider_request_failed", message, responseMetadata)
      : permanentFailure("confluence", "invalid_content", message, responseMetadata);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return retryableFailure("confluence", "nango_proxy_failed", message, metadata);
  }
}

function toJiraNangoProxyEndpoint(
  endpoint: string,
  integration: WorkspaceIntegrationRecord,
): { ok: true; endpoint: string } | { ok: false; error: string } {
  const normalizedEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  if (normalizedEndpoint.startsWith("/ex/jira/")) {
    return { ok: true, endpoint: normalizedEndpoint };
  }

  const cloudId = readJiraCloudId(integration.metadata);
  if (!cloudId) {
    return {
      ok: false,
      error:
        `Jira writeback for ${integration.connectionId} requires cloudId metadata ` +
        "from Nango connection_config before proxying adapter REST requests.",
    };
  }

  return { ok: true, endpoint: `/ex/jira/${encodeURIComponent(cloudId)}${normalizedEndpoint}` };
}

function toConfluenceNangoProxyEndpoint(
  endpoint: string,
  integration: WorkspaceIntegrationRecord,
): { ok: true; endpoint: string } | { ok: false; error: string } {
  const normalizedEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  if (normalizedEndpoint.startsWith("/ex/confluence/")) {
    return { ok: true, endpoint: normalizedEndpoint };
  }

  // Confluence Cloud, like Jira, is reached through the Atlassian OAuth 2.0
  // (3LO) gateway at api.atlassian.com, which requires the
  // /ex/confluence/{cloudId} prefix — a bare /wiki/api/v2/... is not routable.
  // The adapter resolver emits the product REST path; cloud owns the gateway
  // prefix + connection metadata (mirrors toJiraNangoProxyEndpoint). The
  // cloudId is shared across Atlassian Cloud providers, so the Jira reader
  // applies here too.
  const cloudId = readJiraCloudId(integration.metadata);
  if (!cloudId) {
    return {
      ok: false,
      error:
        `Confluence writeback for ${integration.connectionId} requires cloudId metadata ` +
        "from Nango connection_config before proxying adapter REST requests.",
    };
  }
  return {
    ok: true,
    endpoint: `/ex/confluence/${encodeURIComponent(cloudId)}${normalizedEndpoint}`,
  };
}

// Resolve a Confluence space key (e.g. "OPS") to its numeric v2 spaceId via the
// Confluence REST API. Returns null when the lookup is not possible so the
// caller can fall back to the original (key-based) request.
async function resolveConfluenceNumericSpaceId(
  spaceKey: string,
  integration: WorkspaceIntegrationRecord,
): Promise<string | null> {
  const ep = toConfluenceNangoProxyEndpoint(
    `/wiki/api/v2/spaces?keys=${encodeURIComponent(spaceKey)}`,
    integration,
  );
  if (!ep.ok) return null;
  try {
    const res = await proxyThroughNango<{ results?: Array<{ id?: string | number }> }>({
      connectionId: integration.connectionId,
      backendIntegrationId: resolveBackendIntegrationId(integration),
      method: "GET",
      endpoint: ep.endpoint,
    });
    const id = res.data?.results?.[0]?.id;
    return id !== undefined && id !== null ? String(id) : null;
  } catch {
    return null;
  }
}

// Inject a resolved spaceId into a JSON writeback payload so the adapter resolver
// emits the numeric id Confluence v2 requires. No-op on non-JSON content.
function injectSpaceId(content: string, spaceId: string): string {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return JSON.stringify({ ...(parsed as Record<string, unknown>), spaceId });
    }
  } catch {
    // fall through to original content
  }
  return content;
}

function resolveJiraTransitionWriteback(path: string, content: string): JiraWritebackRequest {
  const match = path.match(/^\/jira\/issues\/([^/]+)\/transitions\/[^/]+\.json$/);
  if (!match?.[1]) {
    throw new Error(`No Jira writeback rule matched ${path}`);
  }
  const parsed = safeParseJson(content);
  const transition =
    typeof parsed === "string"
      ? { id: parsed.trim() }
      : isRecord(parsed) && isRecord(parsed.transition)
        ? { id: readString(parsed.transition, "id") ?? "" }
        : isRecord(parsed)
          ? { id: readString(parsed, "id") ?? "" }
          : { id: "" };
  if (!transition.id) {
    throw new Error("issue transition writeback requires transition.id");
  }
  return {
    action: "transition_issue",
    method: "POST",
    endpoint: `/rest/api/3/issue/${encodeURIComponent(extractJiraIdFromPathSegment(match[1]))}/transitions`,
    body: { transition },
  } as unknown as JiraWritebackRequest;
}

function extractJiraIdFromPathSegment(segment: string): string {
  const decoded = decodePathSegment(segment, "Jira issue id");
  const currentSuffix = /__([^/]+)$/u.exec(decoded);
  if (currentSuffix?.[1]) {
    return currentSuffix[1];
  }
  const legacySuffix = /--([^/]+)$/u.exec(decoded);
  return legacySuffix?.[1] ? legacySuffix[1] : decoded;
}

function readJiraCloudId(metadata: Record<string, unknown>): string | null {
  return firstString(
    metadata.cloudId,
    metadata.cloudID,
    metadata.cloud_id,
    readNested(metadata, ["connection_config", "cloudId"]),
    readNested(metadata, ["connection_config", "cloudID"]),
    readNested(metadata, ["connectionConfig", "cloudId"]),
    readNested(metadata, ["connectionConfig", "cloudID"]),
    readNested(metadata, ["metadata", "cloudId"]),
    readNested(metadata, ["metadata", "cloudID"]),
  );
}

function extractJiraExternalId(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  return (
    readString(payload, "id") ??
    readString(payload, "key") ??
    extractExternalId(payload)
  );
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function readNested(record: Record<string, unknown>, path: string[]): unknown {
  let value: unknown = record;
  for (const key of path) {
    if (!isRecord(value)) {
      return undefined;
    }
    value = value[key];
  }
  return value;
}

function readPositiveInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function readReviewCommentSide(
  record: Record<string, unknown>,
  key: string,
): "LEFT" | "RIGHT" | undefined {
  const value = record[key];
  return value === "LEFT" || value === "RIGHT" ? value : undefined;
}

function parseGitHubReviewCommentContent(content: string): GitHubReviewCommentInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid review comment JSON: ${message}`);
  }

  if (!isRecord(parsed)) {
    throw new Error("GitHub review comment payload must be a JSON object");
  }

  const metadata = isRecord(parsed.metadata) ? parsed.metadata : {};
  const body = readString(parsed, "body");
  if (!body) {
    throw new Error("GitHub review comment payload.body must be a non-empty string");
  }

  return {
    body,
    commitId:
      readString(parsed, "commit_id") ??
      readString(parsed, "commitSha") ??
      readString(metadata, "commitSha"),
    path: readString(parsed, "path"),
    line: readPositiveInteger(parsed, "line"),
    side: readReviewCommentSide(parsed, "side") ?? "RIGHT",
    inReplyTo:
      readPositiveInteger(parsed, "in_reply_to_id") ??
      readPositiveInteger(parsed, "inReplyToId"),
  };
}

function decodePathSegment(encoded: string, field: string): string {
  const decoded = decodeURIComponent(encoded);
  if (decoded.includes("/")) {
    throw new Error(`Invalid ${field} in writeback path: encoded path separators are not allowed`);
  }
  return decoded;
}

function rejectEncodedPathSeparators(path: string, field: string): void {
  for (const segment of path.split("/")) {
    if (segment) {
      decodePathSegment(segment, field);
    }
  }
}

function resolveGitHubReviewCommentTarget(
  path: string,
  content: string,
): GitHubReviewCommentTarget {
  const reviewCommentMatch = path.match(
    /^\/github\/repos\/([^/]+)\/([^/]+)\/pulls\/([1-9]\d*)(?:__[^/]+)?\/comments\/[^/]+(?:\.json)?$/,
  );

  if (reviewCommentMatch) {
    return {
      owner: decodePathSegment(reviewCommentMatch[1] ?? "", "owner"),
      repo: decodePathSegment(reviewCommentMatch[2] ?? "", "repo"),
      prNumber: Number.parseInt(reviewCommentMatch[3] ?? "0", 10),
    };
  }

  const repoCommentMatch = path.match(
    /^\/github\/repos\/([^/]+)\/([^/]+)\/comments\/[^/]+(?:\.json)?$/,
  );
  if (!repoCommentMatch) {
    throw new Error(
      `Unsupported GitHub writeback path: ${path}. Expected a pull request review or review comment file.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = null;
  }

  const payload = isRecord(parsed) ? parsed : {};
  const metadata = isRecord(payload.metadata) ? payload.metadata : {};
  const prNumber =
    readPositiveInteger(payload, "pullRequestNumber") ??
    readPositiveInteger(payload, "prNumber") ??
    readPositiveInteger(metadata, "pullRequestNumber") ??
    readPositiveInteger(metadata, "prNumber");

  if (!prNumber) {
    throw new Error(
      `GitHub review comment writeback ${path} must include metadata.prNumber when the path omits /pulls/{n}/comments/.`,
    );
  }

  return {
    owner: decodePathSegment(repoCommentMatch[1] ?? "", "owner"),
    repo: decodePathSegment(repoCommentMatch[2] ?? "", "repo"),
    prNumber,
  };
}

async function executeGitHubReviewCommentWriteback(
  input: RelayfileWritebackInput,
  integration: WorkspaceIntegrationRecord,
): Promise<RelayfileWritebackExecutionResult> {
  let target: GitHubReviewCommentTarget;
  let comment: GitHubReviewCommentInput;

  try {
    target = resolveGitHubReviewCommentTarget(input.path, input.content);
    comment = parseGitHubReviewCommentContent(input.content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return permanentFailure("github", "invalid_content", message);
  }

  const endpoint = `/repos/${target.owner}/${target.repo}/pulls/${target.prNumber}/comments`;
  const requestBody = comment.inReplyTo
    ? {
        body: comment.body,
        in_reply_to: comment.inReplyTo,
      }
    : {
        body: comment.body,
        commit_id: comment.commitId,
        path: comment.path,
        line: comment.line,
        side: comment.side ?? "RIGHT",
      };

  if (!comment.inReplyTo) {
    if (!comment.commitId) {
      return permanentFailure(
        "github",
        "invalid_content",
        "GitHub review comment writeback requires commit_id or metadata.commitSha",
      );
    }
    if (!comment.path) {
      return permanentFailure(
        "github",
        "invalid_content",
        "GitHub review comment writeback requires path for new review comments",
      );
    }
    if (!comment.line) {
      return permanentFailure(
        "github",
        "invalid_content",
        "GitHub review comment writeback requires line for new review comments",
      );
    }
  }

  const metadata: RelayfileProviderResultMetadata = {
    provider: integration.provider,
    action: "create_review_comment",
    method: "POST",
    endpoint,
  };

  try {
    const response = await proxyThroughNango<Record<string, unknown>>({
      connectionId: integration.connectionId,
      backendIntegrationId: resolveBackendIntegrationId(integration),
      method: "POST",
      endpoint,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      data: requestBody,
    });

    const responseMetadata = {
      ...metadata,
      status: response.status,
      ...(extractExternalId(response.data) ? { externalId: extractExternalId(response.data) } : {}),
    } satisfies RelayfileProviderResultMetadata;

    if (response.ok) {
      return successResult("github", responseMetadata);
    }

    const message = readMessageFromPayload(
      response.data,
      `GitHub review comment writeback failed with status ${response.status}`,
    );

    return isRetryableStatus(response.status)
      ? retryableFailure("github", "provider_request_failed", message, responseMetadata)
      : permanentFailure("github", "invalid_content", message, responseMetadata);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return retryableFailure("github", "nango_proxy_failed", message, metadata);
  }
}

async function executeGitHubIssueWriteback(
  input: RelayfileWritebackInput,
  integration: WorkspaceIntegrationRecord,
): Promise<RelayfileWritebackExecutionResult> {
  let request: GitHubIssueWritebackRequest;
  try {
    request = resolveGitHubIssueWritebackRequest(input.path, input.content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return permanentFailure("github", "invalid_content", message);
  }

  const metadata: RelayfileProviderResultMetadata = {
    provider: integration.provider,
    action: request.action,
    method: request.method,
    endpoint: request.endpoint,
  };

  try {
    const response = await proxyThroughNango<Record<string, unknown>>({
      connectionId: integration.connectionId,
      backendIntegrationId: resolveBackendIntegrationId(integration),
      method: request.method,
      endpoint: request.endpoint,
      headers: {
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      data: request.body,
    });

    const responseMetadata = {
      ...metadata,
      status: response.status,
      ...(extractExternalId(response.data) ? { externalId: extractExternalId(response.data) } : {}),
    } satisfies RelayfileProviderResultMetadata;

    if (response.ok) {
      return successResult("github", responseMetadata);
    }

    const message = readMessageFromPayload(
      response.data,
      `GitHub issue writeback failed with status ${response.status}`,
    );

    return isRetryableStatus(response.status)
      ? retryableFailure("github", "provider_request_failed", message, responseMetadata)
      : permanentFailure("github", "invalid_content", message, responseMetadata);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return retryableFailure("github", "nango_proxy_failed", message, metadata);
  }
}

async function executeGitHubMergePullRequestWriteback(
  input: RelayfileWritebackInput,
  integration: WorkspaceIntegrationRecord,
): Promise<RelayfileWritebackExecutionResult> {
  let request: GitHubMergePullRequestWritebackRequest;
  try {
    request = resolveGitHubMergePullRequestWritebackRequest(input.path, input.content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return permanentFailure("github", "invalid_content", message);
  }

  const metadata: RelayfileProviderResultMetadata = {
    provider: integration.provider,
    action: request.action,
    method: request.method,
    endpoint: request.endpoint,
  };

  try {
    const response = await proxyThroughNango<Record<string, unknown>>({
      connectionId: request.connectionId ?? integration.connectionId,
      backendIntegrationId: request.providerConfigKey ?? resolveBackendIntegrationId(integration),
      method: request.method,
      endpoint: request.endpoint,
      headers: {
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      data: request.body,
    });

    const sha = isRecord(response.data) && typeof response.data.sha === "string"
      ? response.data.sha
      : undefined;
    const responseMetadata = {
      ...metadata,
      status: response.status,
      ...(sha ? { externalId: sha } : {}),
    } satisfies RelayfileProviderResultMetadata;

    if (response.ok) {
      return successResult("github", responseMetadata);
    }

    const message = readMessageFromPayload(
      response.data,
      `GitHub pull request merge failed with status ${response.status}`,
    );

    return isRetryableStatus(response.status)
      ? retryableFailure("github", "provider_request_failed", message, responseMetadata)
      : permanentFailure("github", "invalid_content", message, responseMetadata);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return retryableFailure("github", "nango_proxy_failed", message, metadata);
  }
}

function resolveGitHubIssueWritebackRequest(
  path: string,
  content: string,
): GitHubIssueWritebackRequest {
  const issueLabelsMatch = path.match(
    /^\/github\/repos\/([^/]+)\/([^/]+)\/issues\/([1-9]\d*)(?:__[^/]+)?\/labels\/([^/]+)\.json$/,
  );
  if (issueLabelsMatch) {
    const owner = decodePathSegment(issueLabelsMatch[1] ?? "", "owner");
    const repo = decodePathSegment(issueLabelsMatch[2] ?? "", "repo");
    const issueNumber = issueLabelsMatch[3] ?? "";
    const body = parseGitHubIssueLabelsBody(content);
    return {
      action: "add_issue_labels",
      method: "POST",
      endpoint: `/repos/${owner}/${repo}/issues/${issueNumber}/labels`,
      body,
    };
  }

  const issueCommentMatch = path.match(
    /^\/github\/repos\/([^/]+)\/([^/]+)\/issues\/([1-9]\d*)(?:__[^/]+)?\/comments\/([^/]+)\.json$/,
  );
  if (issueCommentMatch) {
    const owner = decodePathSegment(issueCommentMatch[1] ?? "", "owner");
    const repo = decodePathSegment(issueCommentMatch[2] ?? "", "repo");
    const issueNumber = issueCommentMatch[3] ?? "";
    const commentId = decodePathSegment(issueCommentMatch[4] ?? "", "comment id");
    const body = parseGitHubIssueCommentBody(content);
    if (/^[1-9]\d*$/.test(commentId)) {
      return {
        action: "update_issue_comment",
        method: "PATCH",
        endpoint: `/repos/${owner}/${repo}/issues/comments/${commentId}`,
        body,
      };
    }
    return {
      action: "create_issue_comment",
      method: "POST",
      endpoint: `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      body,
    };
  }

  const issueMatch = path.match(/^\/github\/repos\/([^/]+)\/([^/]+)\/issues\/([^/]+)\.json$/);
  if (!issueMatch) {
    throw new Error(`Unsupported GitHub issue writeback path: ${path}`);
  }
  const owner = decodePathSegment(issueMatch[1] ?? "", "owner");
  const repo = decodePathSegment(issueMatch[2] ?? "", "repo");
  const issueSegment = decodePathSegment(issueMatch[3] ?? "", "issue number");
  if (issueSegment === "_index" || issueSegment === "meta" || issueSegment === "metadata") {
    throw new Error(`Unsupported GitHub issue writeback path: ${path}`);
  }
  const body = parseGitHubIssueBody(content);
  if (/^[1-9]\d*$/.test(issueSegment)) {
    if (Object.keys(body).length === 0) {
      throw new Error("GitHub issue update payload requires at least one mutable field");
    }
    return {
      action: "update_issue",
      method: "PATCH",
      endpoint: `/repos/${owner}/${repo}/issues/${issueSegment}`,
      body,
    };
  }
  if (typeof body.title !== "string" || body.title.trim().length === 0) {
    throw new Error("GitHub issue create payload.title must be a non-empty string");
  }
  return {
    action: "create_issue",
    method: "POST",
    endpoint: `/repos/${owner}/${repo}/issues`,
    body,
  };
}

function resolveGitHubMergePullRequestWritebackRequest(
  path: string,
  content: string,
): GitHubMergePullRequestWritebackRequest {
  const match = path.match(
    /^\/github\/repos\/([^/]+)\/([^/]+)\/pulls\/([1-9]\d*)(?:__[^/]+)?\/merge\.json$/,
  );
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new Error(`Unsupported GitHub pull request merge writeback path: ${path}`);
  }
  const owner = decodePathSegment(match[1], "owner");
  const repo = decodePathSegment(match[2], "repo");
  const pullNumber = match[3];
  const body = parseGitHubMergePullRequestBody(content);
  const metadata = parseGitHubMergePullRequestMetadata(body.sourceMetadata);
  delete body.sourceMetadata;
  return {
    action: "merge_pull_request",
    method: "PUT",
    endpoint: `/repos/${owner}/${repo}/pulls/${pullNumber}/merge`,
    body,
    ...(metadata.connectionId ? { connectionId: metadata.connectionId } : {}),
    ...(metadata.providerConfigKey ? { providerConfigKey: metadata.providerConfigKey } : {}),
  };
}

function parseGitHubMergePullRequestBody(
  content: string,
): GitHubMergePullRequestWritebackRequest["body"] & {
  sourceMetadata?: unknown;
} {
  const parsed = safeParseJson(content);
  if (!isRecord(parsed)) {
    throw new Error("GitHub pull request merge payload must be a JSON object");
  }
  rejectReadOnlyGitHubFields(parsed);
  const methodValue = Object.hasOwn(parsed, "method")
    ? parsed.method
    : Object.hasOwn(parsed, "merge_method")
      ? parsed.merge_method
      : "squash";
  if (methodValue !== "merge" && methodValue !== "squash" && methodValue !== "rebase") {
    throw new Error("GitHub pull request merge payload.method must be one of merge, squash, rebase");
  }
  const body: GitHubMergePullRequestWritebackRequest["body"] & {
    sourceMetadata?: unknown;
  } = {
    merge_method: methodValue,
  };
  const commitTitle = readOptionalStringField(parsed, "commitTitle", "GitHub pull request merge payload.commitTitle")
    ?? readOptionalStringField(parsed, "commit_title", "GitHub pull request merge payload.commit_title");
  const commitMessage = readOptionalStringField(parsed, "commitMessage", "GitHub pull request merge payload.commitMessage")
    ?? readOptionalStringField(parsed, "commit_message", "GitHub pull request merge payload.commit_message");
  const sha = readOptionalStringField(parsed, "sha", "GitHub pull request merge payload.sha");
  if (commitTitle) body.commit_title = commitTitle;
  if (commitMessage) body.commit_message = commitMessage;
  if (sha) body.sha = sha;
  if (Object.hasOwn(parsed, "metadata")) body.sourceMetadata = parsed.metadata;
  return body;
}

function parseGitHubMergePullRequestMetadata(value: unknown): {
  connectionId?: string;
  providerConfigKey?: string;
} {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("GitHub pull request merge payload.metadata must be an object when provided");
  }
  const connectionId = readOptionalStringField(
    value,
    "connectionId",
    "GitHub pull request merge payload.metadata.connectionId",
  );
  const providerConfigKey = readOptionalStringField(
    value,
    "providerConfigKey",
    "GitHub pull request merge payload.metadata.providerConfigKey",
  );
  return {
    ...(connectionId ? { connectionId } : {}),
    ...(providerConfigKey ? { providerConfigKey } : {}),
  };
}

function readOptionalStringField(
  record: Record<string, unknown>,
  key: string,
  context: string,
): string | undefined {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  throw new Error(`${context} must be a non-empty string when provided`);
}

function parseGitHubIssueBody(content: string): Record<string, unknown> {
  const parsed = safeParseJson(content);
  if (!isRecord(parsed)) {
    throw new Error("GitHub issue payload must be a JSON object");
  }
  rejectReadOnlyGitHubFields(parsed);
  const body: Record<string, unknown> = {};
  for (const key of ["title", "body", "state"] as const) {
    const value = readString(parsed, key);
    if (value) body[key] = value;
  }
  for (const key of ["labels", "assignees"] as const) {
    const value = parsed[key];
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      body[key] = value;
    }
  }
  if (typeof parsed.milestone === "string" || typeof parsed.milestone === "number") {
    body.milestone = parsed.milestone;
  }
  return body;
}

function parseGitHubIssueLabelsBody(content: string): { labels: string[] } {
  const parsed = safeParseJson(content);
  if (!isRecord(parsed)) {
    throw new Error("GitHub issue labels payload must be a JSON object");
  }
  rejectReadOnlyGitHubFields(parsed);
  const labels = parsed.labels;
  if (!Array.isArray(labels) || labels.length === 0 || !labels.every((entry) =>
    typeof entry === "string" && entry.trim().length > 0
  )) {
    throw new Error("GitHub issue labels payload.labels must be a non-empty string array");
  }
  return { labels: labels.map((label) => label.trim()) };
}

function parseGitHubIssueCommentBody(content: string): Record<string, unknown> {
  const parsed = safeParseJson(content);
  if (typeof parsed === "string") {
    const body = parsed.trim();
    if (!body) throw new Error("GitHub issue comment payload.body must be a non-empty string");
    return { body };
  }
  if (!isRecord(parsed)) {
    throw new Error("GitHub issue comment payload must be a JSON object or plain string");
  }
  rejectReadOnlyGitHubFields(parsed);
  const body = readString(parsed, "body");
  if (!body) throw new Error("GitHub issue comment payload.body must be a non-empty string");
  return { body };
}

function rejectReadOnlyGitHubFields(payload: Record<string, unknown>): void {
  for (const key of ["id", "node_id", "url", "html_url", "number", "created_at", "updated_at"] as const) {
    if (key in payload) {
      throw new Error(`GitHub writeback payload includes read-only field ${key}`);
    }
  }
}

async function executeGitHubWriteback(
  input: RelayfileWritebackInput,
  integration: WorkspaceIntegrationRecord,
): Promise<RelayfileWritebackExecutionResult> {
  if (input.path.includes("/issues/")) {
    return executeGitHubIssueWriteback(input, integration);
  }

  if (input.path.endsWith("/merge.json")) {
    return executeGitHubMergePullRequestWriteback(input, integration);
  }

  if (input.path.includes("/comments/")) {
    return executeGitHubReviewCommentWriteback(input, integration);
  }

  let lastStatus: number | undefined;
  const handler = new GitHubWritebackHandler(
    {
      name: "github",
      async proxy(request) {
        const response = await proxyThroughNango<Record<string, unknown>>({
          connectionId: integration.connectionId,
          backendIntegrationId: resolveBackendIntegrationId(integration),
          method: request.method,
          endpoint: request.endpoint,
          headers: request.headers,
          data: request.body,
        });

        lastStatus = response.status;

        return {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          data: response.data as never,
        };
      },
    },
    {
      defaultConnectionId: integration.connectionId,
      defaultProviderConfigKey: resolveBackendIntegrationId(integration),
      resolveConnectionId: () => integration.connectionId,
    },
  );

  const pathMatch = input.path.match(
    /^\/github\/repos\/([^/]+)\/([^/]+)\/pulls\/([1-9]\d*)\/reviews\/[^/]+(?:\.json)?$/,
  );
  const metadata: RelayfileProviderResultMetadata = {
    provider: integration.provider,
    action: "create_review",
    method: "POST",
    endpoint: pathMatch
      ? (() => {
          try {
            return `/repos/${decodePathSegment(pathMatch[1] ?? "", "owner")}/${decodePathSegment(pathMatch[2] ?? "", "repo")}/pulls/${pathMatch[3]}/reviews`;
          } catch {
            return undefined;
          }
        })()
      : undefined,
  };

  const result = await handler.writeBack(input.workspaceId, input.path, input.content);
  if (result.success) {
    return successResult("github", {
      ...metadata,
      ...(lastStatus ? { status: lastStatus } : {}),
      ...(result.externalId ? { externalId: result.externalId } : {}),
    });
  }

  const message = sanitizeText(result.error ?? "GitHub writeback failed");
  if (lastStatus && isRetryableStatus(lastStatus)) {
    return retryableFailure("github", "provider_request_failed", message, {
      ...metadata,
      status: lastStatus,
    });
  }

  if (message.toLowerCase().includes("unsupported github writeback path")) {
    return permanentFailure("github", "unsupported_path", message, metadata);
  }

  return permanentFailure("github", "invalid_content", message, {
    ...metadata,
    ...(lastStatus ? { status: lastStatus } : {}),
  });
}

async function executeGitLabWriteback(
  input: RelayfileWritebackInput,
  integration: WorkspaceIntegrationRecord,
): Promise<RelayfileWritebackExecutionResult> {
  const backendIntegrationId = resolveBackendIntegrationId(integration);
  let lastStatus: number | undefined;

  // ConnectionProvider that routes the adapter handler's REST calls through the
  // workspace's Nango connection (the same boundary every other executor uses).
  const provider: GitLabConnectionProvider = {
    name: "gitlab",
    // The writeback handler only ever calls proxy(); healthCheck is part of the
    // ConnectionProvider contract but unused on this path.
    async healthCheck(): Promise<boolean> {
      return true;
    },
    async proxy<T = unknown>(
      request: GitLabProxyRequest,
    ): Promise<GitLabProxyResponse<T>> {
      const response = await proxyThroughNango<Record<string, unknown>>({
        connectionId: integration.connectionId,
        backendIntegrationId,
        method: request.method,
        endpoint: request.endpoint,
        headers: request.headers,
        data: request.body,
      });
      lastStatus = response.status;
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        data: response.data as T,
      };
    },
  };
  const handler = new GitLabWritebackHandler(provider, {
    connectionId: integration.connectionId,
  });

  // Delete (issue note / merge-request discussion note): the adapter resolves a
  // concrete DELETE request, which we proxy directly.
  if (input.action === "file_delete") {
    let request: GitLabWritebackRequest;
    try {
      request = handler.resolveDeleteRequest(input.path);
    } catch (error) {
      return permanentFailure(
        "gitlab",
        "unsupported_path",
        error instanceof Error ? error.message : String(error),
      );
    }
    const metadata: RelayfileProviderResultMetadata = {
      provider: integration.provider,
      action: request.action,
      method: request.method,
      endpoint: request.endpoint,
    };
    try {
      const response = await proxyThroughNango<Record<string, unknown>>({
        connectionId: integration.connectionId,
        backendIntegrationId,
        method: request.method,
        endpoint: request.endpoint,
        data: request.body,
      });
      if (response.ok) {
        return successResult("gitlab", { ...metadata, status: response.status });
      }
      const message = readMessageFromPayload(
        response.data,
        `GitLab delete failed with status ${response.status}`,
      );
      return isRetryableStatus(response.status)
        ? retryableFailure("gitlab", "provider_request_failed", message, {
            ...metadata,
            status: response.status,
          })
        : permanentFailure("gitlab", "invalid_content", message, {
            ...metadata,
            status: response.status,
          });
    } catch (error) {
      return retryableFailure(
        "gitlab",
        "nango_proxy_failed",
        error instanceof Error ? error.message : String(error),
        metadata,
      );
    }
  }

  // Create / update (issue, issue note, merge request, MR discussion).
  const result = await handler.writeBack(
    input.workspaceId,
    input.path,
    input.content,
  );
  const metadata: RelayfileProviderResultMetadata = {
    provider: integration.provider,
    ...(lastStatus ? { status: lastStatus } : {}),
  };
  if (result.success) {
    return successResult("gitlab", {
      ...metadata,
      ...(result.externalId ? { externalId: result.externalId } : {}),
    });
  }

  const message = sanitizeText(result.error ?? "GitLab writeback failed");
  if (lastStatus && isRetryableStatus(lastStatus)) {
    return retryableFailure("gitlab", "provider_request_failed", message, metadata);
  }
  // An unsupported path surfaces from the handler as a thrown-then-caught error.
  const code = /unsupported gitlab writeback path/i.test(message)
    ? "unsupported_path"
    : "invalid_content";
  return permanentFailure("gitlab", code, message, metadata);
}

export async function executeRelayfileProviderWriteback(
  input: RelayfileWritebackInput,
  options?: {
    fetchImpl?: typeof fetch;
    resolveBotToken?: (workspaceId: string) => Promise<string | null>;
  },
): Promise<RelayfileWritebackExecutionResult> {
  const providerFromPath = inferProviderFromPath(input.path);
  const providerFromInput = normalizeRequestedProvider(input.provider);

  if (!providerFromPath) {
    return permanentFailure(
      input.provider?.trim() || "unknown",
      "unsupported_path",
      `Unsupported RelayFile writeback path: ${input.path}`,
    );
  }

  if (providerFromInput && providerFromInput !== providerFromPath) {
    return permanentFailure(
      providerFromPath,
      "provider_mismatch",
      `Writeback provider ${input.provider} does not match path ${input.path}`,
    );
  }

  // Cloud-specific business decision, not catalog-derivable: the adapters
  // catalog does list dropbox writeback resources, but the cloud's Dropbox
  // mount is intentionally metadata-only.
  if (providerFromPath === "dropbox") {
    return permanentFailure(
      "dropbox",
      "unsupported_path",
      "Dropbox Relayfile mount is metadata-only. Use Dropbox Nango actions (get-file-temporary-link or download-file-content) for lazy file content retrieval.",
    );
  }

  const { integration, candidateWorkspaceIds } =
    await resolveWorkspaceIntegrationForWriteback(
      input.workspaceId,
      providerFromPath,
    );
  if (!integration) {
    return permanentFailure(
      providerFromPath,
      "integration_not_found",
      `No ${providerFromPath} integration is configured for workspace ${input.workspaceId} ` +
        `(candidates tried: ${candidateWorkspaceIds.join(", ")})`,
    );
  }

  if (providerFromPath === "slack") {
    return executeSlackWriteback(input, integration, options);
  }

  return WRITEBACK_EXECUTORS[providerFromPath](input, integration);
}

function executionResultFromReceipt(
  receipt: RelayfileWritebackReceipt,
): RelayfileWritebackExecutionResult {
  const metadata = (receipt.metadata ?? undefined) as
    | RelayfileProviderResultMetadata
    | undefined;
  if (receipt.outcome === "permanent_failure") {
    return permanentFailure(
      receipt.provider,
      (receipt.errorCode ?? "invalid_content") as PermanentErrorCode,
      receipt.errorMessage ?? "Provider writeback failed",
      metadata,
    );
  }
  return successResult(
    receipt.provider,
    metadata ?? { provider: receipt.provider },
  );
}

async function recordWritebackReceiptBestEffort(
  input: RelayfileWritebackInput,
  result: RelayfileWritebackExecutionResult,
): Promise<void> {
  try {
    await recordRelayfileWritebackReceipt({
      workspaceId: input.workspaceId,
      opId: input.opId,
      provider: result.provider,
      outcome: result.outcome === "success" ? "success" : "permanent_failure",
      errorCode: result.outcome === "permanent_failure" ? result.error.code : null,
      errorMessage: result.outcome === "permanent_failure" ? result.error.message : null,
      metadata: result.metadata ?? null,
    });
  } catch (error) {
    // Best-effort: the provider op already happened, so failing the writeback
    // over a receipt-write error would itself trigger the re-dispatch we are
    // guarding against. Degrades to the pre-receipt behavior for this op.
    console.warn("relayfile_writeback_receipt_record_failed", {
      workspaceId: input.workspaceId,
      opId: input.opId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function markWritebackReceiptAckedBestEffort(
  input: RelayfileWritebackInput,
): Promise<void> {
  try {
    await markRelayfileWritebackReceiptAcked({
      workspaceId: input.workspaceId,
      opId: input.opId,
    });
  } catch (error) {
    console.warn("relayfile_writeback_receipt_ack_mark_failed", {
      workspaceId: input.workspaceId,
      opId: input.opId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleRelayfileProviderWriteback(
  input: RelayfileWritebackInput,
  options?: {
    fetchImpl?: typeof fetch;
    resolveBotToken?: (workspaceId: string) => Promise<string | null>;
  },
): Promise<RelayfileWritebackResult> {
  // Idempotency guard, keyed on (opId, workspaceId): a prior attempt may have
  // applied the provider mutation and failed only the relayfile ack
  // (`relayfile_ack_failed`), in which case relayfile re-delivers the same op
  // after recovery. Re-dispatching would double-apply the provider op, so a
  // durable receipt of the terminal outcome makes the retry ack-only. A
  // lookup error propagates (fail-closed, like the integration lookup inside
  // the dispatch path): relayfile retries later without a provider dispatch.
  const receipt = await findRelayfileWritebackReceipt({
    workspaceId: input.workspaceId,
    opId: input.opId,
  });

  const result = receipt
    ? executionResultFromReceipt(receipt)
    : await executeRelayfileProviderWriteback(input, options);

  if (result.outcome === "retryable_failure") {
    return {
      ...result,
      relayfileAcked: false,
    };
  }

  if (!receipt) {
    // Persist the terminal outcome BEFORE the ack attempt so an ack outage
    // cannot turn into a provider re-dispatch on the retry that follows it.
    await recordWritebackReceiptBestEffort(input, result);
  }

  try {
    await ackRelayfileWriteback(
      input,
      result.outcome === "success",
      result.outcome === "permanent_failure" ? result.error.message : undefined,
      result.outcome === "success" ? result.metadata : undefined,
      options?.fetchImpl,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      outcome: "retryable_failure",
      provider: result.provider,
      error: {
        code: "relayfile_ack_failed",
        message: sanitizeText(message),
      },
      ...(result.metadata ? { metadata: result.metadata } : {}),
      relayfileAcked: false,
    };
  }

  await markWritebackReceiptAckedBestEffort(input);

  return {
    ...result,
    relayfileAcked: true,
  };
}
