import { timingSafeEqual } from "node:crypto";
import {
  buildDatabaseQuery,
  buildFilter as buildDatabaseFilter,
  buildSorts as buildDatabaseSorts,
  type NotionFilterCondition,
  type NotionSortCondition,
} from "@relayfile/adapter-notion";
import { z } from "zod";
import { getNangoClient } from "@/lib/integrations/nango-service";
import {
  readBearerTokenFromRequest,
  readConfiguredSpecialistCloudApiToken,
} from "@/lib/integrations/slack-proxy-auth";
import { getWorkspaceIntegration } from "@/lib/integrations/workspace-integrations";

const NOTION_API_VERSION = "2022-06-28";
const NOTION_JSON_CONTENT_TYPE = "application/json";
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;

const NotionQueryRequestSchema = z.object({
  workspaceId: z.string().trim().min(1),
  operation: z.enum([
    "listPages",
    "listDatabases",
    "searchPages",
    "getPage",
    "getDatabase",
    "listBlocks",
  ]),
  params: z.record(z.string(), z.unknown()).default({}),
});

type NotionQueryOperation = z.infer<typeof NotionQueryRequestSchema>["operation"];
type SupportedMethod = "GET" | "POST";
type ProxyQuery = Record<string, string | number | boolean | null | undefined>;

type NotionProxyRequest = {
  method: SupportedMethod;
  path: string;
  query?: ProxyQuery;
  body?: unknown;
};

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function verifyBearerToken(request: Request): { ok: true } | { ok: false; status: 401 | 403 } {
  const providedToken = readBearerTokenFromRequest(request);
  if (!providedToken) {
    return { ok: false, status: 401 };
  }

  const expectedToken = readConfiguredSpecialistCloudApiToken();
  if (!expectedToken || !constantTimeEqual(providedToken, expectedToken)) {
    return { ok: false, status: 403 };
  }

  return { ok: true };
}

function readOptionalString(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function readPageSize(params: Record<string, unknown>): number {
  const raw = params.page_size ?? params.pageSize ?? params.per_page ?? params.perPage ?? params.limit;
  const requested = typeof raw === "number" && Number.isFinite(raw)
    ? Math.floor(raw)
    : DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(MAX_PAGE_SIZE, requested));
}

function readStartCursor(params: Record<string, unknown>): string | undefined {
  const value = params.start_cursor ?? params.startCursor ?? params.cursor;
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function readRequiredId(
  params: Record<string, unknown>,
  keys: readonly string[],
): string {
  for (const key of keys) {
    const value = readOptionalString(params, key);
    if (value) {
      return value;
    }
  }

  const expected = keys.map((key) => `params.${key}`).join(" or ");
  throw new Error(`${expected} must be a non-empty string.`);
}

function buildSearchBody(
  params: Record<string, unknown>,
  objectType: "page" | "database",
  requireQuery: boolean,
): Record<string, unknown> {
  const query = readOptionalString(params, "query");
  if (requireQuery && !query) {
    throw new Error("params.query must be a non-empty string.");
  }

  const startCursor = readStartCursor(params);
  return {
    ...(query ? { query } : {}),
    ...(startCursor ? { start_cursor: startCursor } : {}),
    page_size: readPageSize(params),
    filter: {
      property: "object",
      value: objectType,
    },
  };
}

function buildDatabaseQueryBody(params: Record<string, unknown>): Record<string, unknown> {
  const query = buildDatabaseQuery({
    pageSize: readPageSize(params),
    startCursor: readStartCursor(params),
  });
  const filter = buildCompatibleDatabaseFilter(params.filter);
  const sorts = buildCompatibleDatabaseSorts(params.sorts);
  return {
    ...query,
    ...(filter ? { filter } : {}),
    ...(sorts ? { sorts } : {}),
  };
}

function buildCompatibleDatabaseFilter(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (!isAdapterFilterCondition(value)) {
    return value;
  }

  try {
    return buildDatabaseFilter(value);
  } catch {
    return value;
  }
}

function buildCompatibleDatabaseSorts(
  value: unknown,
): Array<Record<string, string>> | unknown[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  if (!value.every(isSortConditionLike)) {
    return value;
  }

  const builtSorts = buildDatabaseSorts(value);
  return builtSorts.map((sort, index) => {
    const source = value[index];
    if (!isRecord(source) || Object.hasOwn(source, "direction")) {
      return sort;
    }

    const { direction: _direction, ...rest } = sort;
    return rest;
  });
}

function isAdapterFilterCondition(value: unknown): value is NotionFilterCondition {
  if (!isRecord(value)) {
    return false;
  }

  const andConditions = Array.isArray(value.and) ? value.and : undefined;
  const orConditions = Array.isArray(value.or) ? value.or : undefined;
  if (andConditions || orConditions) {
    const groups = [andConditions, orConditions].filter(Array.isArray) as unknown[][];
    return groups.length > 0 && groups.every((group) => group.every(isAdapterFilterCondition));
  }

  return (
    typeof value.timestamp === "string" ||
    Object.hasOwn(value, "operator") ||
    Object.hasOwn(value, "type") ||
    Object.hasOwn(value, "value")
  );
}

function isSortConditionLike(value: unknown): value is NotionSortCondition {
  return isRecord(value) && (
    typeof value.property === "string" ||
    typeof value.timestamp === "string"
  );
}

function buildNotionProxyRequest(
  operation: NotionQueryOperation,
  params: Record<string, unknown>,
): NotionProxyRequest {
  if (operation === "listPages") {
    const databaseId = readOptionalString(params, "database")
      ?? readOptionalString(params, "databaseId")
      ?? readOptionalString(params, "database_id");
    if (databaseId) {
      return {
        method: "POST",
        path: `/v1/databases/${encodeURIComponent(databaseId)}/query`,
        body: buildDatabaseQueryBody(params),
      };
    }

    return {
      method: "POST",
      path: "/v1/search",
      body: buildSearchBody(params, "page", false),
    };
  }

  if (operation === "listDatabases") {
    return {
      method: "POST",
      path: "/v1/search",
      body: buildSearchBody(params, "database", false),
    };
  }

  if (operation === "searchPages") {
    return {
      method: "POST",
      path: "/v1/search",
      body: buildSearchBody(params, "page", true),
    };
  }

  if (operation === "getPage") {
    const pageId = readRequiredId(params, ["pageId", "page_id", "id"]);
    return {
      method: "GET",
      path: `/v1/pages/${encodeURIComponent(pageId)}`,
    };
  }

  if (operation === "getDatabase") {
    const databaseId = readRequiredId(params, ["databaseId", "database_id", "id"]);
    return {
      method: "GET",
      path: `/v1/databases/${encodeURIComponent(databaseId)}`,
    };
  }

  const blockId = readRequiredId(params, ["blockId", "block_id", "pageId", "page_id", "id"]);
  const startCursor = readStartCursor(params);
  return {
    method: "GET",
    path: `/v1/blocks/${encodeURIComponent(blockId)}/children`,
    query: {
      page_size: readPageSize(params),
      start_cursor: startCursor,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!isRecord(headers)) return undefined;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      const value = headers[key];
      if (typeof value === "string") return value;
      if (Array.isArray(value) && typeof value[0] === "string") return value[0];
    }
  }
  return undefined;
}

function normalizeParams(query?: ProxyQuery): Record<string, string> | undefined {
  if (!query) return undefined;

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = String(value);
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function axiosErrorResponse(error: unknown):
  | { status: number; data: unknown; headers: unknown }
  | null {
  if (!isRecord(error)) return null;
  const response = error.response;
  if (!isRecord(response)) return null;
  const status = typeof response.status === "number" ? response.status : null;
  if (status === null) return null;
  return {
    status,
    data: response.data,
    headers: response.headers,
  };
}

async function fetchNotionViaNango(input: {
  connectionId: string;
  providerConfigKey: string;
  method: SupportedMethod;
  path: string;
  query?: ProxyQuery;
  body?: unknown;
}): Promise<Response> {
  const endpoint = input.path.startsWith("/") ? input.path : `/${input.path}`;
  const client = getNangoClient();

  let status: number;
  let data: unknown;
  let responseHeaders: unknown;

  try {
    const response = await client.proxy<unknown>({
      method: input.method,
      endpoint,
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey,
      headers: {
        "Content-Type": NOTION_JSON_CONTENT_TYPE,
        "Notion-Version": NOTION_API_VERSION,
      },
      responseType: "text",
      ...(normalizeParams(input.query)
        ? { params: normalizeParams(input.query) as Record<string, string> }
        : {}),
      ...(input.body === undefined ? {} : { data: input.body }),
    });
    status = response.status;
    data = response.data;
    responseHeaders = response.headers;
  } catch (error) {
    const info = axiosErrorResponse(error);
    if (!info) {
      if (error instanceof Error) throw error;
      throw new Error(`Nango proxy ${endpoint} failed: ${String(error)}`);
    }
    status = info.status;
    data = info.data;
    responseHeaders = info.headers;
  }

  const contentType =
    readHeader(responseHeaders, "content-type") ?? NOTION_JSON_CONTENT_TYPE;

  if (status === 204 || status === 205 || status === 304) {
    return new Response(null, {
      status,
      headers: { "content-type": contentType },
    });
  }

  let body: string;
  if (typeof data === "string") {
    body = data;
  } else if (data === null || data === undefined) {
    body = "";
  } else {
    body = JSON.stringify(data);
  }

  return new Response(body, {
    status,
    headers: { "content-type": contentType },
  });
}

function jsonError(error: string, status: 400 | 401 | 403 | 404 | 500 | 502): Response {
  return Response.json({ ok: false, error }, { status });
}

export async function POST(request: Request): Promise<Response> {
  try {
    return await handlePost(request);
  } catch (error) {
    console.error("[api/notion/query] unhandled error", {
      errorName: error instanceof Error ? error.constructor.name : typeof error,
      errorMessage:
        error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
    });
    return jsonError(
      error instanceof Error ? error.message : "Notion query proxy failed.",
      500,
    );
  }
}

async function handlePost(request: Request): Promise<Response> {
  const auth = verifyBearerToken(request);
  if (!auth.ok) {
    return jsonError(auth.status === 401 ? "Unauthorized" : "Forbidden", auth.status);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonError("Invalid request body.", 400);
  }

  const parsed = NotionQueryRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return jsonError("Invalid request body.", 400);
  }

  let notionRequest: NotionProxyRequest;
  try {
    notionRequest = buildNotionProxyRequest(parsed.data.operation, parsed.data.params);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid request body.", 400);
  }

  const integration = await getWorkspaceIntegration(parsed.data.workspaceId, "notion");
  if (!integration) {
    return jsonError("Notion workspace integration was not found.", 404);
  }

  const providerConfigKey = integration.providerConfigKey?.trim() ?? "";
  if (!providerConfigKey) {
    return jsonError("Notion workspace integration is missing a provider config key.", 502);
  }

  try {
    return await fetchNotionViaNango({
      connectionId: integration.connectionId,
      providerConfigKey,
      ...notionRequest,
    });
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Notion query proxy failed.",
      502,
    );
  }
}
