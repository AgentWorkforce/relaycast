import type { LinearWritebackRequest } from "@relayfile/adapter-linear/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function extractExternalId(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  return (
    readString(payload, "id") ??
    readString(payload, "uuid") ??
    readString(payload, "externalId")
  );
}

export function extractLinearExternalId(
  payload: unknown,
  action: LinearWritebackRequest["action"],
): string | undefined {
  if (!isRecord(payload)) return undefined;
  const directExternalId = extractExternalId(payload);
  const data = payload.data;
  if (!isRecord(data)) return directExternalId;

  const mutationKey = linearMutationKey(action);
  if (!mutationKey) return directExternalId;
  const mutation = data[mutationKey];
  if (!isRecord(mutation)) return directExternalId;

  const target =
    action === "create_comment"
      ? mutation.comment
      : action === "create_agent_activity"
        ? mutation.agentActivity
        : action === "create_label" || action === "update_label"
          ? mutation.issueLabel
        : action === "create-project" || action === "update-project"
          ? mutation.project
          : mutation.issue;
  return extractExternalId(target) ?? directExternalId;
}

export function extractLinearRequestExternalId(
  request: LinearWritebackRequest,
): string | undefined {
  const variables = request.body.variables;
  if (!isRecord(variables)) return undefined;
  return readString(variables, "id");
}

export function extractLinearMutationOutcome(
  payload: unknown,
  action: LinearWritebackRequest["action"],
): { success: boolean | undefined; message: string | undefined } {
  if (!isRecord(payload)) return { success: undefined, message: undefined };
  const directSuccess = readMutationSuccess(payload);
  if (directSuccess.success !== undefined) {
    return directSuccess;
  }
  if (action === "add-issues-to-project") {
    return readAddIssuesToProjectOutcome(payload);
  }

  const data = payload.data;
  if (!isRecord(data)) return { success: undefined, message: undefined };

  const mutationKey = linearMutationKey(action);
  if (!mutationKey) return { success: undefined, message: undefined };
  const mutation = data[mutationKey];
  if (!isRecord(mutation)) return { success: undefined, message: undefined };

  const success = typeof mutation.success === "boolean" ? mutation.success : undefined;
  return {
    success,
    message:
      success === false
        ? `Linear ${mutationKey} returned success: false`
        : undefined,
  };
}

export function linearMutationKey(
  action: LinearWritebackRequest["action"],
): string | null {
  switch (action) {
    case "add-issues-to-project":
      return null;
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
    case "archive-project":
      return "projectArchive";
    case "create-project":
      return "projectCreate";
    case "update_issue":
      return "issueUpdate";
    case "update_label":
      return "issueLabelUpdate";
    case "update-project":
      return "projectUpdate";
  }
  return null;
}

function readMutationSuccess(
  record: Record<string, unknown>,
): { success: boolean | undefined; message: string | undefined } {
  const success = typeof record.success === "boolean" ? record.success : undefined;
  return {
    success,
    message: success === false ? "Linear writeback returned success: false" : undefined,
  };
}

function readAddIssuesToProjectOutcome(
  payload: Record<string, unknown>,
): { success: boolean | undefined; message: string | undefined } {
  const results = payload.results;
  if (!Array.isArray(results)) {
    return { success: undefined, message: undefined };
  }

  const failures = results.filter(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) && entry.success === false,
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

export function extractLinearGraphQLErrors(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const errors = payload.errors;
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  const messages = errors
    .map((entry) => (isRecord(entry) && typeof entry.message === "string" ? entry.message : null))
    .filter((entry): entry is string => Boolean(entry));
  return messages.length > 0 ? messages.join("; ") : undefined;
}
