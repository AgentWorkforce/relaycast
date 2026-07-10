import {
  resolveJiraDeleteRequest,
  resolveJiraWritebackRequest,
} from "@relayfile/adapter-jira/writeback";
import type { JiraWritebackRequest } from "@relayfile/adapter-jira/types";
import type {
  DispatchMetadata,
  DispatchResult,
  IntegrationCredential,
  ProviderDispatchOptions,
  WritebackEnv,
  WritebackInput,
} from "../types.js";
import {
  type AdapterProxyRequest,
  extractExternalId,
  firstString,
  isRecord,
  isRetryableStatus,
  permanentFailure,
  proxyAdapterRequest,
  readMessageFromPayload,
  readNested,
  readString,
  retryableFailure,
  success,
} from "./common.js";

export async function dispatch(
  input: WritebackInput,
  cred: IntegrationCredential,
  env: WritebackEnv,
  options: ProviderDispatchOptions = {},
): Promise<DispatchResult> {
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
        return permanentFailure(message, { provider: "jira" });
      }
    } else {
      return permanentFailure(error, { provider: "jira" });
    }
  }

  const endpointResult = toJiraNangoProxyEndpoint(
    request.endpoint,
    cred.aliasFields,
  );
  const baseMetadata: DispatchMetadata = {
    provider: "jira",
    action: request.action,
    method: request.method,
    endpoint: endpointResult.ok ? endpointResult.endpoint : request.endpoint,
  };
  if (!endpointResult.ok) {
    return permanentFailure(endpointResult.error, baseMetadata);
  }

  const proxyRequest: AdapterProxyRequest = {
    action: request.action,
    method: request.method,
    endpoint: endpointResult.endpoint,
    ...(request.body ? { body: request.body } : {}),
    ...(request.body
      ? { headers: { "Content-Type": "application/json; charset=utf-8" } }
      : {}),
  };

  try {
    const response = await proxyAdapterRequest<Record<string, unknown>>(
      cred,
      proxyRequest,
      env,
      options,
    );
    const externalId = extractJiraExternalId(response.data);
    const responseMetadata: DispatchMetadata = {
      ...baseMetadata,
      status: response.status,
      ...(externalId ? { externalId } : {}),
    };
    if (response.ok) {
      return success(responseMetadata, externalId);
    }
    const message = readMessageFromPayload(
      response.data,
      `jira writeback failed with status ${response.status}`,
    );
    return isRetryableStatus(response.status)
      ? retryableFailure(message, responseMetadata)
      : permanentFailure(message, responseMetadata);
  } catch (error) {
    return retryableFailure(error, baseMetadata);
  }
}

function toJiraNangoProxyEndpoint(
  endpoint: string,
  aliasFields: Record<string, unknown>,
): { ok: true; endpoint: string } | { ok: false; error: string } {
  const normalizedEndpoint = endpoint.startsWith("/")
    ? endpoint
    : `/${endpoint}`;
  if (normalizedEndpoint.startsWith("/ex/jira/")) {
    return { ok: true, endpoint: normalizedEndpoint };
  }
  const cloudId = readJiraCloudId(aliasFields);
  if (!cloudId) {
    return {
      ok: false,
      error:
        "Jira writeback requires cloudId metadata from Nango connection_config before proxying adapter REST requests.",
    };
  }
  return {
    ok: true,
    endpoint: `/ex/jira/${encodeURIComponent(cloudId)}${normalizedEndpoint}`,
  };
}

function readJiraCloudId(aliasFields: Record<string, unknown>): string | null {
  return firstString(
    aliasFields.cloudId,
    aliasFields.cloudID,
    aliasFields.cloud_id,
    readNested(aliasFields, ["connection_config", "cloudId"]),
    readNested(aliasFields, ["connection_config", "cloudID"]),
    readNested(aliasFields, ["connectionConfig", "cloudId"]),
    readNested(aliasFields, ["connectionConfig", "cloudID"]),
    readNested(aliasFields, ["metadata", "cloudId"]),
    readNested(aliasFields, ["metadata", "cloudID"]),
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

function resolveJiraTransitionWriteback(
  path: string,
  content: string,
): JiraWritebackRequest {
  const match = path.match(
    /^\/jira\/issues\/([^/]+)\/transitions\/[^/]+\.json$/,
  );
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

function decodePathSegment(encoded: string, field: string): string {
  const decoded = decodeURIComponent(encoded);
  if (decoded.includes("/")) {
    throw new Error(
      `Invalid ${field} in writeback path: encoded path separators are not allowed`,
    );
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

function safeParseJson(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return content;
  }
}
