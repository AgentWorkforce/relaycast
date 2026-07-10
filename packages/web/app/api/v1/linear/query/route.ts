import { timingSafeEqual } from "node:crypto";
import {
  LINEAR_LIST_ISSUES_QUERY,
  buildLinearIssueFilter as buildIssueFilter,
} from "@relayfile/adapter-linear";
import { z } from "zod";
import { getNangoHost, getNangoSecretKey } from "@/lib/integrations/nango-service";
import {
  readBearerTokenFromRequest,
  readConfiguredSpecialistCloudApiToken,
} from "@/lib/integrations/slack-proxy-auth";
import { getWorkspaceIntegration } from "@/lib/integrations/workspace-integrations";

// Linear's API is GraphQL-only — there is no REST surface. Every operation
// becomes a GraphQL query POSTed to /graphql. The earlier REST-style impl
// (path: "/issues", "/projects", etc.) returned 404s in production; the
// specialist treated those as null/empty results and the librarian fallback
// silently returned no findings. (Caught by codex P1 review on PR #375.)
const LINEAR_GRAPHQL_PATH = "/graphql";
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

const LinearQueryRequestSchema = z.object({
  workspaceId: z.string().trim().min(1),
  operation: z.enum([
    "listIssues",
    "searchIssues",
    "getIssue",
    "listProjects",
    "listComments",
  ]),
  params: z.record(z.string(), z.unknown()).default({}),
});

type LinearQueryOperation = z.infer<typeof LinearQueryRequestSchema>["operation"];

interface LinearGraphQLRequest {
  query: string;
  variables: Record<string, unknown>;
}

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

function readRequiredString(
  params: Record<string, unknown>,
  key: string,
): string {
  const value = params[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`params.${key} must be a non-empty string.`);
  }
  return value.trim();
}

function readRequiredStringFromKeys(
  params: Record<string, unknown>,
  keys: string[],
  label: string,
): string {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  throw new Error(`${label} must be a non-empty string.`);
}

function readOptionalString(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = params[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

/**
 * Read a list-shaped param. Accepts either:
 *   - `string[]` → returned as-is (after trimming + filtering empty)
 *   - `string` → split on commas (Linear specialist client may serialize a
 *     comma-list when forwarding from filter arrays)
 *   - anything else → returns []
 *
 * Without this, array-valued params like `labels: ["bug", "urgent"]` got
 * silently dropped by the previous `readQueryValue` helper which only kept
 * `string | number | boolean`. (Caught by devin + codex P2 review on PR #375.)
 */
function readStringList(
  params: Record<string, unknown>,
  key: string,
): string[] {
  const value = params[key];
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return [];
}

function readLimit(params: Record<string, unknown>): number {
  const raw = params.limit ?? params.per_page ?? params.perPage ?? params.first;
  const requested = typeof raw === "number" && Number.isFinite(raw)
    ? Math.floor(raw)
    : DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, requested));
}

// ─────────────────────────────────────────────────────────────────────
// GraphQL query construction
// ─────────────────────────────────────────────────────────────────────
//
// Keep the inline fragment for operations that do not yet consume adapter-owned
// query documents in this route.
const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  priority
  createdAt
  updatedAt
  state { id name type }
  assignee { id name email }
  team { id key name }
  project { id name }
  labels(first: 20) { nodes { id name } }
`;

const PROJECT_FIELDS = `
  id
  name
  description
  state
  url
  createdAt
  updatedAt
  lead { id name }
  teams(first: 5) { nodes { id key name } }
`;

const COMMENT_FIELDS = `
  id
  body
  url
  createdAt
  user { id name email }
`;

function buildLinearGraphQLRequest(
  operation: LinearQueryOperation,
  params: Record<string, unknown>,
): LinearGraphQLRequest {
  switch (operation) {
    case "listIssues": {
      const filter = buildIssueFilter({
        state: readStringList(params, "state"),
        labels: readStringList(params, "labels"),
        assignee: readOptionalString(params, "assignee"),
        team: readOptionalString(params, "team"),
        project: readOptionalString(params, "project"),
      });
      return {
        query: LINEAR_LIST_ISSUES_QUERY,
        variables: {
          first: readLimit(params),
          ...(filter ? { filter } : {}),
        },
      };
    }

    case "searchIssues": {
      const term = readRequiredString(params, "query");
      // Linear has both a top-level `searchIssues` query and `issueSearch`.
      // We use `searchIssues(term:)` which returns IssueConnection — the
      // common path on current Linear API.
      return {
        query: `query Search($term: String!, $first: Int) {
  searchIssues(term: $term, first: $first) {
    nodes {${ISSUE_FIELDS}}
  }
}`,
        variables: {
          term,
          first: readLimit(params),
        },
      };
    }

    case "listProjects": {
      return {
        query: `query Projects($first: Int) {
  projects(first: $first) {
    nodes {${PROJECT_FIELDS}}
  }
}`,
        variables: {
          first: readLimit(params),
        },
      };
    }

    case "getIssue": {
      const id = readRequiredStringFromKeys(
        params,
        ["id", "issueId", "identifier"],
        "One of params.id, params.issueId, or params.identifier",
      );
      return {
        query: `query Issue($id: String!) {
  issue(id: $id) {${ISSUE_FIELDS}}
}`,
        variables: { id },
      };
    }

    case "listComments": {
      const issueId = readRequiredStringFromKeys(
        params,
        ["issueId", "issue", "id", "identifier"],
        "One of params.issueId, params.issue, params.id, or params.identifier",
      );
      return {
        query: `query IssueComments($issueId: String!, $first: Int) {
  issue(id: $issueId) {
    comments(first: $first) {
      nodes {${COMMENT_FIELDS}}
    }
  }
}`,
        variables: {
          issueId,
          first: readLimit(params),
        },
      };
    }
  }
}

async function fetchLinearViaNango(input: {
  connectionId: string;
  integrationId: string;
  graphql: LinearGraphQLRequest;
}): Promise<Response> {
  const secretKey = getNangoSecretKey();
  if (!secretKey) {
    throw new Error("NANGO_SECRET_KEY is not configured.");
  }

  const response = await fetch(
    new URL(`/v1/${encodeURIComponent(input.integrationId)}/proxy`, `${getNangoHost()}/`),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        Accept: "application/json",
        "Connection-Id": input.connectionId,
        "Content-Type": "application/json",
        "Provider-Config-Key": input.integrationId,
      },
      body: JSON.stringify({
        connectionId: input.connectionId,
        endpoint: LINEAR_GRAPHQL_PATH,
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        data: {
          query: input.graphql.query,
          variables: input.graphql.variables,
        },
      }),
      cache: "no-store",
    },
  );

  return response;
}

function unwrapLinearGraphQLResponse(
  operation: LinearQueryOperation,
  bodyText: string,
): unknown | undefined {
  if (bodyText.trim().length === 0) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return undefined;
  }

  if (!isRecord(parsed) || Array.isArray(parsed.errors)) {
    return undefined;
  }

  const data = asRecord(parsed.data);
  switch (operation) {
    case "listIssues":
      return readNodes(asRecord(data.issues));
    case "searchIssues":
      return { items: readNodes(asRecord(data.searchIssues)) };
    case "getIssue":
      return data.issue ?? null;
    case "listProjects":
      return readNodes(asRecord(data.projects));
    case "listComments":
      return readNodes(asRecord(asRecord(data.issue).comments));
  }
}

function readNodes(value: Record<string, unknown>): unknown[] {
  return Array.isArray(value.nodes) ? value.nodes : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function jsonError(error: string, status: 400 | 401 | 403 | 404 | 500 | 502): Response {
  return Response.json({ ok: false, error }, { status });
}

export async function POST(request: Request): Promise<Response> {
  try {
    return await handlePost(request);
  } catch (error) {
    console.error("[api/linear/query] unhandled error", {
      errorName: error instanceof Error ? error.constructor.name : typeof error,
      errorMessage:
        error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
    });
    return jsonError(
      error instanceof Error ? error.message : "Linear query proxy failed.",
      500,
    );
  }
}

async function handlePost(request: Request): Promise<Response> {
  const auth = verifyBearerToken(request);
  if (!auth.ok) {
    const status = auth.status;
    return jsonError(status === 401 ? "Unauthorized" : "Forbidden", status);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonError("Invalid request body.", 400);
  }

  const parsed = LinearQueryRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return jsonError("Invalid request body.", 400);
  }

  let graphql: LinearGraphQLRequest;
  try {
    graphql = buildLinearGraphQLRequest(parsed.data.operation, parsed.data.params);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid request body.", 400);
  }

  const integration = await getWorkspaceIntegration(parsed.data.workspaceId, "linear");
  if (!integration) {
    return jsonError("Linear workspace integration was not found.", 404);
  }

  const providerConfigKey = integration.providerConfigKey?.trim() ?? "";
  if (!providerConfigKey) {
    return jsonError("Linear workspace integration is missing a provider config key.", 502);
  }

  try {
    const linearResponse = await fetchLinearViaNango({
      connectionId: integration.connectionId,
      integrationId: providerConfigKey,
      graphql,
    });
    const body = await linearResponse.text();
    const contentType = linearResponse.headers.get("content-type") ?? "application/json";
    const normalizedBody = linearResponse.ok
      ? unwrapLinearGraphQLResponse(parsed.data.operation, body)
      : undefined;

    return new Response(
      normalizedBody === undefined ? body : JSON.stringify(normalizedBody),
      {
        status: linearResponse.status,
        headers: {
          "content-type": normalizedBody === undefined ? contentType : "application/json",
        },
      },
    );
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Linear query proxy failed.",
      502,
    );
  }
}
