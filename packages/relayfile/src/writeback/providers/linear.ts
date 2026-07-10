import {
  resolveDeleteRequest as resolveLinearDeleteRequest,
  resolveWritebackRequest as resolveLinearWritebackRequest,
} from "@relayfile/adapter-linear/writeback";
import type { LinearWritebackRequest } from "@relayfile/adapter-linear/types";
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
  extractExternalId,
  isRecord,
  isRetryableStatus,
  permanentFailure,
  readString,
  readMessageFromPayload,
  retryableFailure,
  success,
} from "./common.js";

export async function dispatch(
  input: WritebackInput,
  cred: IntegrationCredential,
  env: WritebackEnv,
  options: ProviderDispatchOptions = {},
): Promise<DispatchResult> {
  let request: LinearWritebackRequest;
  try {
    request =
      input.action === "file_delete"
        ? resolveLinearDeleteRequest(input.path)
        : resolveLinearWritebackRequest(input.path, input.content);
  } catch (error) {
    return permanentFailure(error, { provider: "linear" });
  }

  const metadata: DispatchMetadata = {
    provider: "linear",
    action: request.action,
    method: request.method,
    endpoint: request.endpoint,
  };

  try {
    const response = await nangoProxy<Record<string, unknown>>(
      cred,
      {
        method: request.method,
        endpoint: request.endpoint,
        data: request.body,
      },
      env,
      options,
    );
    const externalId =
      extractLinearExternalId(response.data, request.action) ??
      extractLinearRequestExternalId(request);
    const linearErrors = extractLinearGraphQLErrors(response.data);
    const mutationOutcome = extractLinearMutationOutcome(
      response.data,
      request.action,
    );
    const responseMetadata = {
      ...metadata,
      status: response.status,
      ...(externalId ? { externalId } : {}),
    };
    if (response.ok && !linearErrors && mutationOutcome.success !== false) {
      return success(responseMetadata, externalId);
    }
    const message =
      linearErrors ??
      mutationOutcome.message ??
      readMessageFromPayload(
        response.data,
        `Linear writeback failed with status ${response.status}`,
      );
    return isRetryableStatus(response.status)
      ? retryableFailure(message, responseMetadata)
      : permanentFailure(message, responseMetadata);
  } catch (error) {
    return retryableFailure(error, metadata);
  }
}

function extractLinearExternalId(
  payload: unknown,
  action: LinearWritebackRequest["action"],
): string | undefined {
  if (!isRecord(payload)) return undefined;
  const directExternalId = extractLinearDirectExternalId(payload);
  const data = payload["data"];
  if (!isRecord(data)) return directExternalId;
  const mutationKey = linearMutationKey(action);
  if (!mutationKey) return directExternalId;
  const mutation = data[mutationKey];
  if (!isRecord(mutation)) return directExternalId;
  return (
    extractExternalId(linearMutationTarget(mutation, action)) ??
    directExternalId
  );
}

function extractLinearDirectExternalId(
  payload: Record<string, unknown>,
): string | undefined {
  return (
    extractExternalId(payload) ??
    readString(payload, "uuid") ??
    readString(payload, "externalId")
  );
}

function extractLinearRequestExternalId(
  request: LinearWritebackRequest,
): string | undefined {
  const variables = request.body.variables;
  if (!isRecord(variables)) return undefined;
  return readString(variables, "id");
}

function linearMutationTarget(
  mutation: Record<string, unknown>,
  action: LinearWritebackRequest["action"],
): unknown {
  switch (action) {
    case "create_agent_activity":
      return mutation["agentActivity"];
    case "create_comment":
      return mutation["comment"];
    case "create_label":
    case "update_label":
      return mutation["issueLabel"];
    case "create-project":
    case "update-project":
      return mutation["project"];
    default:
      return mutation["issue"];
  }
}

function extractLinearMutationOutcome(
  payload: unknown,
  action: LinearWritebackRequest["action"],
): { success: boolean | undefined; message: string | undefined } {
  if (!isRecord(payload)) return { success: undefined, message: undefined };
  const directSuccess = readLinearDirectSuccess(payload);
  if (directSuccess.success !== undefined) {
    return directSuccess;
  }
  if (action === "add-issues-to-project") {
    return readLinearAddIssuesOutcome(payload);
  }
  const data = payload["data"];
  if (!isRecord(data)) return { success: undefined, message: undefined };
  const mutationKey = linearMutationKey(action);
  if (!mutationKey) return { success: undefined, message: undefined };
  const mutation = data[mutationKey];
  if (!isRecord(mutation)) return { success: undefined, message: undefined };
  const success =
    typeof mutation["success"] === "boolean" ? mutation["success"] : undefined;
  return {
    success,
    message:
      success === false
        ? `Linear ${mutationKey} returned success: false`
        : undefined,
  };
}

function readLinearDirectSuccess(payload: Record<string, unknown>): {
  success: boolean | undefined;
  message: string | undefined;
} {
  const success =
    typeof payload["success"] === "boolean" ? payload["success"] : undefined;
  return {
    success,
    message:
      success === false
        ? "Linear writeback returned success: false"
        : undefined,
  };
}

function readLinearAddIssuesOutcome(payload: Record<string, unknown>): {
  success: boolean | undefined;
  message: string | undefined;
} {
  const results = payload["results"];
  if (!Array.isArray(results)) {
    return { success: undefined, message: undefined };
  }

  const failures = results.filter(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) && entry["success"] === false,
  );
  if (failures.length === 0) {
    return { success: true, message: undefined };
  }

  const messages = failures
    .map((failure) => readString(failure, "error"))
    .filter((message): message is string => Boolean(message));
  return {
    success: false,
    message:
      messages.length > 0
        ? messages.join("; ")
        : "Linear add-issues-to-project returned failed results",
  };
}

function linearMutationKey(
  action: LinearWritebackRequest["action"],
): string | undefined {
  switch (action) {
    case "create_agent_activity":
      return "agentActivityCreate";
    case "create_comment":
      return "commentCreate";
    case "create_issue":
      return "issueCreate";
    case "create_label":
      return "issueLabelCreate";
    case "delete_issue":
      return "issueDelete";
    case "delete_label":
      return "issueLabelDelete";
    case "update_issue":
      return "issueUpdate";
    case "update_label":
      return "issueLabelUpdate";
    default:
      return undefined;
  }
}

function extractLinearGraphQLErrors(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const errors = payload["errors"];
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  const messages = errors
    .map((entry) =>
      isRecord(entry) && typeof entry["message"] === "string"
        ? entry["message"]
        : null,
    )
    .filter((entry): entry is string => Boolean(entry));
  return messages.length > 0 ? messages.join("; ") : undefined;
}
