/**
 * Notion REST client for the specialist-worker's API fallback path.
 *
 * When the relayfile VFS does not yet hold cached data for a workspace's
 * Notion content, the specialist asks cloud web to proxy Notion REST calls
 * through the workspace's Nango connection. The worker never receives a
 * Notion token directly.
 *
 * Wiring:
 *   packages/specialist-worker/src/routes/a2a-rpc.ts
 *     - reads CLOUD_API_URL + SPECIALIST_CLOUD_API_TOKEN
 *     - constructs this client
 *     - passes the resulting integration into a Notion librarian fallback so
 *       @agent-assistant/specialists can reach live Notion data.
 *
 * See .claude/rules/workers-fetch.md — every outbound call MUST go through
 * globalThis.fetch(...) and consume response bodies on both happy and error
 * paths to avoid leaked Worker response bodies.
 */

const NOTION_QUERY_PATH = "/api/v1/notion/query";
const NOTION_JSON_ACCEPT = "application/json";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const LOG_PREFIX = "[specialist/notion-api-client]";
const NOTION_SOURCE = "notion.cloud.nango";

type FetchImpl = typeof globalThis.fetch;

export interface NotionApiClientOptions {
  cloudApiUrl: string;
  cloudApiToken: string;
  workspaceId: string;
  fetchImpl?: FetchImpl;
}

interface ListWrappedResult<T> {
  data: T;
  summary?: string;
  source?: string;
  timestamp?: string;
}

interface NotionResultEnvelope {
  results?: unknown;
}

interface ListPagesOptions {
  database?: string;
  limit?: number;
  query?: string;
}

interface ListDatabasesOptions {
  limit?: number;
}

interface SearchPagesOptions {
  limit?: number;
}

interface ListBlocksOptions {
  limit?: number;
}

export interface NotionIntegration {
  listPages(opts?: ListPagesOptions): Promise<ListWrappedResult<unknown[]>>;
  listDatabases(opts?: ListDatabasesOptions): Promise<ListWrappedResult<unknown[]>>;
  searchPages(
    query: string,
    opts?: SearchPagesOptions,
  ): Promise<ListWrappedResult<{ items: unknown[] }>>;
  getPage(id: string): Promise<ListWrappedResult<unknown | null>>;
  getDatabase(id: string): Promise<ListWrappedResult<unknown | null>>;
  listBlocks(pageId: string, opts?: ListBlocksOptions): Promise<ListWrappedResult<unknown[]>>;
}

/**
 * Constructs a NotionIntegration-compatible object suitable for the worker's
 * Notion librarian API fallback.
 *
 * All calls go through globalThis.fetch. Response bodies are consumed as text
 * on both happy and error paths before JSON parsing to avoid leaked Worker
 * response bodies.
 */
export function createNotionIntegration(
  options: NotionApiClientOptions,
): NotionIntegration {
  const cloudApiUrl = options.cloudApiUrl?.trim();
  const cloudApiToken = options.cloudApiToken?.trim();
  const workspaceId = options.workspaceId?.trim();

  if (!cloudApiUrl) {
    throw new Error("createNotionIntegration requires a non-empty cloudApiUrl");
  }
  if (!cloudApiToken) {
    throw new Error("createNotionIntegration requires a non-empty cloudApiToken");
  }
  if (!workspaceId) {
    throw new Error("createNotionIntegration requires a non-empty workspaceId");
  }

  const doFetch: FetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const queryUrl = `${trimTrailingSlash(cloudApiUrl)}${NOTION_QUERY_PATH}`;

  async function queryNotionText(
    operation: string,
    params: Record<string, unknown>,
    context: string,
  ): Promise<string | null> {
    try {
      const response = await doFetch(queryUrl, {
        method: "POST",
        headers: {
          Accept: NOTION_JSON_ACCEPT,
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
          `notion cloud query ${context} failed: status=${response.status} body=${bodyText.slice(0, 200)}`,
        );
      }
      return bodyText;
    } catch (error) {
      logFailure(`notion ${context} failed`, error);
      throw error;
    }
  }

  async function queryNotionJson<T>(
    operation: string,
    params: Record<string, unknown>,
    context: string,
  ): Promise<T | null> {
    const bodyText = await queryNotionText(operation, params, context);
    if (bodyText === null || bodyText.trim().length === 0) {
      return null;
    }
    try {
      return JSON.parse(bodyText) as T;
    } catch (error) {
      const parseError = new Error(
        `notion cloud query ${context} returned invalid JSON: ${bodyText.slice(0, 200)}`,
      );
      logFailure(`notion ${context} failed`, error);
      throw parseError;
    }
  }

  async function listPages(
    opts?: ListPagesOptions,
  ): Promise<ListWrappedResult<unknown[]>> {
    const database = opts?.database?.trim();
    const query = opts?.query?.trim();
    const body = await queryNotionJson<unknown[] | NotionResultEnvelope>(
      "listPages",
      {
        ...(database ? { database } : {}),
        ...(query ? { query } : {}),
        limit: normalizeLimit(opts?.limit),
      },
      "listPages",
    );
    return wrapList(extractResults(body));
  }

  async function listDatabases(
    opts?: ListDatabasesOptions,
  ): Promise<ListWrappedResult<unknown[]>> {
    const body = await queryNotionJson<unknown[] | NotionResultEnvelope>(
      "listDatabases",
      { limit: normalizeLimit(opts?.limit) },
      "listDatabases",
    );
    return wrapList(extractResults(body));
  }

  async function searchPages(
    query: string,
    opts?: SearchPagesOptions,
  ): Promise<ListWrappedResult<{ items: unknown[] }>> {
    const body = await queryNotionJson<{ items?: unknown[] } | NotionResultEnvelope>(
      "searchPages",
      { query: query.trim(), limit: normalizeLimit(opts?.limit) },
      "searchPages",
    );
    return {
      data: { items: extractResults(body) },
      source: NOTION_SOURCE,
      timestamp: new Date().toISOString(),
    };
  }

  async function getPage(id: string): Promise<ListWrappedResult<unknown | null>> {
    const body = await queryNotionJson<unknown>(
      "getPage",
      { id: id.trim() },
      `getPage ${id}`,
    );
    return wrapItem(body);
  }

  async function getDatabase(id: string): Promise<ListWrappedResult<unknown | null>> {
    const body = await queryNotionJson<unknown>(
      "getDatabase",
      { id: id.trim() },
      `getDatabase ${id}`,
    );
    return wrapItem(body);
  }

  async function listBlocks(
    pageId: string,
    opts?: ListBlocksOptions,
  ): Promise<ListWrappedResult<unknown[]>> {
    const body = await queryNotionJson<unknown[] | NotionResultEnvelope>(
      "listBlocks",
      { pageId: pageId.trim(), limit: normalizeLimit(opts?.limit) },
      `listBlocks ${pageId}`,
    );
    return wrapList(extractResults(body));
  }

  return {
    listPages,
    listDatabases,
    searchPages,
    getPage,
    getDatabase,
    listBlocks,
  };
}

function wrapList(data: unknown[]): ListWrappedResult<unknown[]> {
  return {
    data,
    source: NOTION_SOURCE,
    timestamp: new Date().toISOString(),
  };
}

function wrapItem(data: unknown | null): ListWrappedResult<unknown | null> {
  return {
    data,
    source: NOTION_SOURCE,
    timestamp: new Date().toISOString(),
  };
}

function extractResults(body: unknown): unknown[] {
  if (Array.isArray(body)) {
    return body;
  }
  if (isRecord(body)) {
    if (Array.isArray(body.results)) {
      return body.results;
    }
    if (Array.isArray(body.items)) {
      return body.items;
    }
  }
  return [];
}

function normalizeLimit(limit?: number): number {
  return Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function logFailure(message: string, error: unknown): void {
  console.warn(LOG_PREFIX, message, errorMessage(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}
