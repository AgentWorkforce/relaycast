import type {
  DispatchResult,
  IntegrationCredential,
  ProviderDispatchOptions,
  WritebackEnv,
  WritebackInput,
} from "../types.js";
import {
  dispatchStandardRequest,
  isRecord,
  permanentFailure,
  readString,
  type AdapterProxyRequest,
} from "./common.js";

const PROVIDER = "google-mail" as const;
const SYSTEM_LABEL_IDS = new Set([
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
const DRAFTISH_FILE_RE = /^(?:draft|create|new|tmp|temp)(?:[._-]|$)/i;

export async function dispatch(
  input: WritebackInput,
  cred: IntegrationCredential,
  env: WritebackEnv,
  options: ProviderDispatchOptions = {},
): Promise<DispatchResult> {
  let request: AdapterProxyRequest;
  try {
    request = resolveGoogleMailRequest(input);
  } catch (error) {
    return permanentFailure(error, { provider: PROVIDER });
  }

  return dispatchStandardRequest(PROVIDER, cred, request, env, options);
}

function resolveGoogleMailRequest(input: WritebackInput): AdapterProxyRequest {
  const parsed = parseGoogleMailPath(input.path);
  if (!parsed) {
    throw new Error(`No Google Mail writeback rule matched ${input.path}`);
  }

  if (input.action === "file_delete") {
    return resolveDeleteRequest(parsed);
  }

  const payload = parsePayload(input.content);
  switch (parsed.resource) {
    case "labels":
      return resolveLabelUpsert(parsed.fileId, payload);
    case "filters":
      return resolveFilterUpsert(parsed.fileId, payload);
    case "send-as":
      return resolveSendAsUpsert(parsed.fileId, payload);
    case "messages":
      return resolveMessageUpsert(parsed.fileId, payload);
    case "threads":
      return resolveThreadUpsert(parsed.fileId, payload);
  }
}

function resolveDeleteRequest(parsed: GoogleMailPath): AdapterProxyRequest {
  switch (parsed.resource) {
    case "labels":
      assertCanonicalLabelId(parsed.fileId, "label delete writeback");
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

function resolveLabelUpsert(
  fileId: string,
  payload: Record<string, unknown>,
): AdapterProxyRequest {
  const create = !isCanonicalLabelId(fileId);
  const body = pickWritable(payload, [
    "name",
    "messageListVisibility",
    "labelListVisibility",
  ]);
  const color = pickWritable(payload, ["textColor", "backgroundColor"]);
  if (Object.keys(color).length > 0) {
    body.color = color;
  }
  if (create && !readString(body, "name")) {
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

function resolveFilterUpsert(
  fileId: string,
  payload: Record<string, unknown>,
): AdapterProxyRequest {
  const create = isDraftLike(fileId) || !sameId(payload, fileId);
  if (!create) {
    throw new Error(
      "Gmail filters cannot be updated in place; delete and recreate the filter",
    );
  }

  const body = normalizeFilterBody(payload);
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

function resolveSendAsUpsert(
  fileId: string,
  payload: Record<string, unknown>,
): AdapterProxyRequest {
  const payloadEmail =
    readString(payload, "sendAsEmail") ?? readString(payload, "id");
  const create =
    isDraftLike(fileId) ||
    (payloadEmail !== undefined && payloadEmail !== fileId);
  const body = pickWritable(payload, [
    "sendAsEmail",
    "displayName",
    "replyToAddress",
    "signature",
    "isDefault",
    "treatAsAlias",
    "smtpMsa",
  ]);
  if (create && !readString(body, "sendAsEmail")) {
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

function resolveMessageUpsert(
  fileId: string,
  payload: Record<string, unknown>,
): AdapterProxyRequest {
  if (isDraftLike(fileId) || !sameId(payload, fileId)) {
    const body = pickWritable(payload, ["raw", "threadId"]);
    if (!readString(body, "raw")) {
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

  const body = pickWritable(payload, ["addLabelIds", "removeLabelIds"]);
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

function resolveThreadUpsert(
  fileId: string,
  payload: Record<string, unknown>,
): AdapterProxyRequest {
  if (isDraftLike(fileId) || !sameId(payload, fileId)) {
    throw new Error(
      "Gmail thread create writeback is not supported; create/send a message instead",
    );
  }

  const body = pickWritable(payload, ["addLabelIds", "removeLabelIds"]);
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

type GoogleMailPath = {
  resource: "labels" | "filters" | "send-as" | "messages" | "threads";
  fileId: string;
};

function parseGoogleMailPath(path: string): GoogleMailPath | null {
  const normalized = path.trim().startsWith("/")
    ? path.trim()
    : `/${path.trim()}`;
  const match = normalized.match(
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

function parsePayload(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error("Google Mail writeback requires a JSON object payload");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch (error) {
    throw new Error(
      `Google Mail writeback requires valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error("Google Mail writeback requires a JSON object payload");
  }
  return parsed;
}

function normalizeFilterBody(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const criteria = isRecord(payload.criteria)
    ? pickWritable(payload.criteria, [
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
    : pickWritable(payload, [
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
    ? pickWritable(payload.action, ["addLabelIds", "removeLabelIds", "forward"])
    : pickWritable(payload, ["addLabelIds", "removeLabelIds", "forward"]);
  return { criteria, action };
}

function pickWritable(
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

function sameId(payload: Record<string, unknown>, fileId: string): boolean {
  const id = readString(payload, "id");
  return id !== undefined && id === fileId;
}

function isDraftLike(fileId: string): boolean {
  return DRAFTISH_FILE_RE.test(fileId);
}

function isReservedJsonFile(fileId: string): boolean {
  return fileId === "_index" || fileId === "meta" || fileId === "metadata";
}

function isCanonicalLabelId(fileId: string): boolean {
  return /^Label_\d+$/u.test(fileId) || SYSTEM_LABEL_IDS.has(fileId);
}

function assertCanonicalLabelId(fileId: string, action: string): void {
  if (!isCanonicalLabelId(fileId)) {
    throw new Error(`${action} requires a canonical Gmail label id`);
  }
}
