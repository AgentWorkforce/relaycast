/**
 * Linear REST client for the specialist-worker's API fallback path.
 *
 * When the RelayFile VFS does not yet hold cached Linear data for a workspace,
 * the specialist asks cloud web to proxy Linear requests through the
 * workspace's Nango connection. The worker never receives a Linear token.
 *
 * Wiring mirrors github-api-client.ts:
 *   - callers pass CLOUD_API_URL + CLOUD_API_TOKEN into the constructor
 *   - every outbound call goes through globalThis.fetch(...)
 *   - response bodies are always consumed before returning or throwing
 *
 * See .claude/rules/workers-fetch.md — leaking a response body in Worker code
 * can stall the runtime's in-flight HTTP cap.
 */

const LINEAR_QUERY_PATH = "/api/v1/linear/query";
const JSON_ACCEPT = "application/json";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const LINEAR_SOURCE = "linear.cloud.nango";
const LOG_PREFIX = "[specialist/api-fallback]";

type FetchImpl = typeof globalThis.fetch;
type LinearQueryOperation =
  | "listIssues"
  | "searchIssues"
  | "getIssue"
  | "listProjects"
  | "listComments";

export interface LinearApiClientOptions {
  cloudApiUrl: string;
  cloudApiToken: string;
  workspaceId: string;
  fetchImpl?: FetchImpl;
}

export interface LinearIssueListOptions {
  state?: string;
  team?: string;
  assignee?: string;
  labels?: string[];
  limit?: number;
}

export interface LinearSearchIssueOptions {
  limit?: number;
}

export interface LinearProjectListOptions {
  state?: string;
  team?: string;
  limit?: number;
}

export interface LinearCommentListOptions {
  limit?: number;
}

export interface ListWrappedResult<T> {
  data: T;
  summary?: string;
  source?: string;
  timestamp?: string;
}

type WrappedResult<T> = ListWrappedResult<T> | T;

export interface LinearIntegration {
  listIssues(opts?: LinearIssueListOptions): Promise<ListWrappedResult<unknown[]>>;
  searchIssues(
    query: string,
    opts?: LinearSearchIssueOptions,
  ): Promise<ListWrappedResult<{ items: unknown[] }>>;
  getIssue(id: string): Promise<ListWrappedResult<unknown | null>>;
  listProjects(opts?: LinearProjectListOptions): Promise<ListWrappedResult<unknown[]>>;
  listComments(
    issueId: string,
    opts?: LinearCommentListOptions,
  ): Promise<ListWrappedResult<unknown[]>>;
}

/**
 * Constructs a Linear integration object suitable for specialist-worker
 * fallback wiring. All calls go through globalThis.fetch, and both success
 * and error paths consume the full response body before returning.
 */
export function createLinearIntegration(
  options: LinearApiClientOptions,
): LinearIntegration {
  const cloudApiUrl = options.cloudApiUrl?.trim();
  const cloudApiToken = options.cloudApiToken?.trim();
  const workspaceId = options.workspaceId?.trim();
  if (!cloudApiUrl) {
    throw new Error("createLinearIntegration requires a non-empty cloudApiUrl");
  }
  if (!cloudApiToken) {
    throw new Error("createLinearIntegration requires a non-empty cloudApiToken");
  }
  if (!workspaceId) {
    throw new Error("createLinearIntegration requires a non-empty workspaceId");
  }

  const doFetch: FetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const queryUrl = `${trimTrailingSlash(cloudApiUrl)}${LINEAR_QUERY_PATH}`;

  async function queryLinearText(
    operation: LinearQueryOperation,
    params: Record<string, unknown>,
    context: string,
  ): Promise<string | null> {
    logInvocation("linear cloud query invoked", {
      operation,
      context,
      workspaceId,
      params,
    });

    try {
      const response = await doFetch(queryUrl, {
        method: "POST",
        headers: {
          Accept: JSON_ACCEPT,
          Authorization: `Bearer ${cloudApiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ workspaceId, operation, params }),
      });
      const bodyText = await response.text().catch(() => "");
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error(
          `linear cloud query ${context} failed: status=${response.status} body=${bodyText.slice(0, 200)}`,
        );
      }
      return bodyText;
    } catch (error) {
      logFailure(`linear ${operation} failed`, error);
      throw error;
    }
  }

  async function queryLinearJson<T>(
    operation: LinearQueryOperation,
    params: Record<string, unknown>,
    context: string,
  ): Promise<T | null> {
    const bodyText = await queryLinearText(operation, params, context);
    if (bodyText === null || bodyText.trim().length === 0) {
      return null;
    }
    try {
      return JSON.parse(bodyText) as T;
    } catch {
      const error = new Error(
        `linear cloud query ${context} returned invalid JSON: ${bodyText.slice(0, 200)}`,
      );
      logFailure(`linear ${operation} failed`, error);
      throw error;
    }
  }

  async function listIssues(
    opts?: LinearIssueListOptions,
  ): Promise<ListWrappedResult<unknown[]>> {
    const body = await queryLinearJson<WrappedResult<unknown[]>>(
      "listIssues",
      withDefinedValues({
        state: normalizeOptionalString(opts?.state),
        team: normalizeOptionalString(opts?.team),
        assignee: normalizeOptionalString(opts?.assignee),
        labels: normalizeStringList(opts?.labels),
        limit: normalizeLimit(opts?.limit),
      }),
      "listIssues",
    );
    const data = unwrapData(body);
    return wrapListResult(Array.isArray(data) ? data : []);
  }

  async function searchIssues(
    query: string,
    opts?: LinearSearchIssueOptions,
  ): Promise<ListWrappedResult<{ items: unknown[] }>> {
    const normalizedQuery = query.trim();
    const body = await queryLinearJson<WrappedResult<{ items?: unknown[] }>>(
      "searchIssues",
      {
        query: normalizedQuery,
        limit: normalizeLimit(opts?.limit),
      },
      `searchIssues ${normalizedQuery}`,
    );
    const data = unwrapData(body);
    return wrapResult({
      items:
        isRecord(data) && Array.isArray(data.items)
          ? data.items
          : [],
    });
  }

  async function getIssue(id: string): Promise<ListWrappedResult<unknown | null>> {
    const issueId = id.trim();
    const body = await queryLinearJson<WrappedResult<unknown | null>>(
      "getIssue",
      { id: issueId },
      `getIssue ${issueId}`,
    );
    return wrapResult(unwrapData(body) ?? null);
  }

  async function listProjects(
    opts?: LinearProjectListOptions,
  ): Promise<ListWrappedResult<unknown[]>> {
    const body = await queryLinearJson<WrappedResult<unknown[]>>(
      "listProjects",
      withDefinedValues({
        state: normalizeOptionalString(opts?.state),
        team: normalizeOptionalString(opts?.team),
        limit: normalizeLimit(opts?.limit),
      }),
      "listProjects",
    );
    const data = unwrapData(body);
    return wrapListResult(Array.isArray(data) ? data : []);
  }

  async function listComments(
    issueId: string,
    opts?: LinearCommentListOptions,
  ): Promise<ListWrappedResult<unknown[]>> {
    const normalizedIssueId = issueId.trim();
    const body = await queryLinearJson<WrappedResult<unknown[]>>(
      "listComments",
      {
        issueId: normalizedIssueId,
        limit: normalizeLimit(opts?.limit),
      },
      `listComments ${normalizedIssueId}`,
    );
    const data = unwrapData(body);
    return wrapListResult(Array.isArray(data) ? data : []);
  }

  return {
    listIssues,
    searchIssues,
    getIssue,
    listProjects,
    listComments,
  };
}

function wrapListResult<T>(data: T[]): ListWrappedResult<T[]> {
  return wrapResult(data);
}

function wrapResult<T>(data: T): ListWrappedResult<T> {
  return {
    data,
    source: LINEAR_SOURCE,
    timestamp: new Date().toISOString(),
  };
}

function unwrapData<T>(value: WrappedResult<T> | null): T | null {
  if (
    isRecord(value) &&
    "data" in value &&
    ("summary" in value || "source" in value || "timestamp" in value)
  ) {
    return value.data as T;
  }
  return (value ?? null) as T | null;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeStringList(values: string[] | undefined): string[] | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }
  const normalized = values
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeLimit(limit: number | undefined): number {
  const requested = typeof limit === "number" && Number.isFinite(limit)
    ? Math.trunc(limit)
    : DEFAULT_LIMIT;
  return Math.min(Math.max(requested, 1), MAX_LIMIT);
}

function withDefinedValues(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function logInvocation(message: string, metadata: Record<string, unknown>): void {
  console.info(LOG_PREFIX, message, metadata);
}

function logFailure(message: string, error: unknown): void {
  console.warn(LOG_PREFIX, message, errorMessage(error));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (isRecord(error)) {
    const response = asRecord(error.response);
    const status = firstString(response.status);
    const data = asRecord(response.data);
    const message = firstString(data.message, error.message);
    return [status ? `status ${status}` : undefined, message].filter(isDefined).join(": ");
  }
  return String(error);
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== undefined && value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}
