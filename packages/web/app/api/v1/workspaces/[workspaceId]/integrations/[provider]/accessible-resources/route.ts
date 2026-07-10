import { NextRequest, NextResponse } from "next/server";
import { resolveRequestAuth } from "@/lib/auth/request-auth";
import { hasWorkspaceReadAccess } from "@/lib/integrations/integration-route-handler";
import {
  getNangoClient,
  getNangoSecretKey,
  getProviderConfigKey,
} from "@/lib/integrations/nango-service";
import {
  isWorkspaceIntegrationProvider,
  resolveWorkspaceIntegrationProvider,
  type WorkspaceIntegrationProvider,
} from "@/lib/integrations/providers";
import { getWorkspaceIntegration } from "@/lib/integrations/workspace-integrations";

// Cross-repo entry point for the "operator picks an upstream resource to bind
// a connection to" flow. The motivating case is Jira / Confluence, where a
// single Atlassian OAuth grant can cover multiple sites (cloudIds). Before
// this endpoint existed, the only way to pick one was to dive into the Nango
// dashboard and hand-edit connection metadata, which is why Jira sync (#535)
// today bails with a clear error and tells operators to set
// `metadata.cloudId`. With this route, the CLI and SDKs can list the sites
// the OAuth grant covers and offer a picker.
//
// We deliberately scope the route to providers that have a meaningful
// concept of "accessible resources" upstream. Today that's Atlassian. Other
// providers get a typed 400 (`provider_has_no_accessible_resources`) so a
// caller wiring this into a generic flow can branch cleanly instead of
// guessing whether the empty list means "no sites" vs "unsupported provider".

type RouteContext = {
  params: Promise<{ workspaceId: string; provider: string }>;
};

type AccessibleResource = {
  id: string;
  url: string;
  name?: string;
  path?: string;
  scopes?: string[];
  avatarUrl?: string;
};

type SuccessBody = {
  ok: true;
  resources: AccessibleResource[];
};

type ErrorBody = {
  ok: false;
  error: string;
  code?: string;
};

type NangoProxyClient = ReturnType<typeof getNangoClient>;

const ATLASSIAN_PROVIDERS = new Set<WorkspaceIntegrationProvider>([
  "jira",
  "confluence",
]);
const GITLAB_PROVIDERS = new Set<WorkspaceIntegrationProvider>(["gitlab"]);
const REDDIT_PROVIDERS = new Set<WorkspaceIntegrationProvider>(["reddit"]);
const REDDIT_BASE_URL = "https://www.reddit.com";

function errorResponse(
  status: number,
  body: { code: string; message: string },
): NextResponse<ErrorBody> {
  return NextResponse.json<ErrorBody>(
    { ok: false, error: body.message, code: body.code },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: string[] = [];
  for (const entry of value) {
    const trimmed = readNonEmptyString(entry);
    if (trimmed) {
      out.push(trimmed);
    }
  }
  return out.length > 0 ? out : undefined;
}

// Atlassian's `/oauth/token/accessible-resources` response is a flat array
// of objects with id+url and optional name/scopes/avatarUrl. We re-shape it
// into the SDK-facing contract here so consumers don't need to know the
// upstream JSON shape, and so we can swap providers later (Composio etc.)
// without breaking the SDK.
function normalizeAtlassianResources(raw: unknown): AccessibleResource[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: AccessibleResource[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = readNonEmptyString(record.id);
    const url = readNonEmptyString(record.url);
    if (!id || !url) {
      continue;
    }
    const resource: AccessibleResource = { id, url };
    const name = readNonEmptyString(record.name);
    if (name) {
      resource.name = name;
    }
    const scopes = readStringArray(record.scopes);
    if (scopes) {
      resource.scopes = scopes;
    }
    const avatarUrl = readNonEmptyString(record.avatarUrl);
    if (avatarUrl) {
      resource.avatarUrl = avatarUrl;
    }
    out.push(resource);
  }
  return out;
}

// GitLab has no Atlassian-style "accessible resources" endpoint. For the
// project-selection flow we expose the user's accessible projects through the
// same Cloud route, keeping the SDK/CLI picker provider-agnostic.
function normalizeGitLabProjects(raw: unknown): AccessibleResource[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: AccessibleResource[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const rawId = record.id;
    const id =
      typeof rawId === "string" || typeof rawId === "number"
        ? String(rawId)
        : undefined;
    const url = readNonEmptyString(record.web_url);
    if (!id || !url) {
      continue;
    }
    const resource: AccessibleResource = { id, url };
    const name =
      readNonEmptyString(record.name_with_namespace) ??
      readNonEmptyString(record.name);
    if (name) {
      resource.name = name;
    }
    const path = readNonEmptyString(record.path_with_namespace);
    if (path) {
      resource.path = path;
    }
    const avatarUrl = readNonEmptyString(record.avatar_url);
    if (avatarUrl) {
      resource.avatarUrl = avatarUrl;
    }
    out.push(resource);
  }
  return out;
}

function normalizeRedditSubreddits(raw: unknown): AccessibleResource[] {
  if (!raw || typeof raw !== "object") {
    return [];
  }
  const listingData = (raw as { data?: unknown }).data;
  if (!listingData || typeof listingData !== "object") {
    return [];
  }
  const children = (listingData as { children?: unknown }).children;
  if (!Array.isArray(children)) {
    return [];
  }

  const out: AccessibleResource[] = [];
  for (const entry of children) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const childData = (entry as { data?: unknown }).data;
    if (!childData || typeof childData !== "object") {
      continue;
    }
    const record = childData as Record<string, unknown>;
    const name = readNonEmptyString(record.display_name) ?? readNonEmptyString(record.name);
    if (!name) {
      continue;
    }
    const normalizedName = name.replace(/^r\//i, "").toLowerCase();
    const resource: AccessibleResource = {
      id: normalizedName,
      url: `https://www.reddit.com/r/${encodeURIComponent(normalizedName)}`,
      name: readNonEmptyString(record.title) ?? `r/${normalizedName}`,
      path: `r/${normalizedName}`,
    };
    const icon = readNonEmptyString(record.icon_img);
    if (icon) {
      resource.avatarUrl = icon;
    }
    out.push(resource);
  }

  return out;
}

async function listGitLabProjectsViaNango(
  nango: NangoProxyClient,
  input: {
    connectionId: string;
    providerConfigKey: string;
  },
): Promise<unknown[]> {
  const perPage = 100;
  const projects: unknown[] = [];
  let page = 1;

  for (;;) {
    const response = await nango.proxy({
      method: "GET",
      endpoint: "/api/v4/projects",
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey,
      params: {
        membership: "true",
        simple: "true",
        per_page: perPage,
        page,
        order_by: "last_activity_at",
        sort: "desc",
      },
      retries: 1,
    });
    if (!Array.isArray(response?.data)) {
      return projects;
    }
    projects.push(...response.data);
    if (response.data.length < perPage) {
      return projects;
    }
    page += 1;
  }
}

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await resolveRequestAuth(request);
  const { workspaceId, provider } = await context.params;

  if (!auth) {
    return errorResponse(401, { code: "unauthorized", message: "Unauthorized" });
  }
  if (!hasWorkspaceReadAccess(auth, workspaceId)) {
    return errorResponse(403, { code: "forbidden", message: "Forbidden" });
  }

  const resolved = resolveWorkspaceIntegrationProvider(provider);
  if (!resolved || !isWorkspaceIntegrationProvider(resolved)) {
    return errorResponse(404, {
      code: "unknown_provider",
      message: "Integration provider not found",
    });
  }

  if (!ATLASSIAN_PROVIDERS.has(resolved) && !GITLAB_PROVIDERS.has(resolved) && !REDDIT_PROVIDERS.has(resolved)) {
    return errorResponse(400, {
      code: "provider_has_no_accessible_resources",
      message:
        `Provider "${resolved}" does not expose accessible resources.`,
    });
  }

  if (!getNangoSecretKey()) {
    return errorResponse(501, {
      code: "backend_not_configured",
      message: "Nango backend not configured",
    });
  }

  const integration = await getWorkspaceIntegration(workspaceId, resolved);
  if (!integration) {
    return errorResponse(404, {
      code: "integration_not_found",
      message: `No ${resolved} integration is connected for this workspace`,
    });
  }

  try {
    const nango = getNangoClient();
    const providerConfigKey =
      integration.providerConfigKey ?? getProviderConfigKey(resolved);
    const query = request.nextUrl.searchParams.get("q")?.trim() ?? "";
    const resources = GITLAB_PROVIDERS.has(resolved)
      ? normalizeGitLabProjects(await listGitLabProjectsViaNango(nango, {
          connectionId: integration.connectionId,
          providerConfigKey,
        }))
      : REDDIT_PROVIDERS.has(resolved)
        ? normalizeRedditSubreddits((await nango.proxy({
            method: "GET",
            endpoint: query ? "/subreddits/search.json" : "/subreddits/popular.json",
            connectionId: integration.connectionId,
            providerConfigKey,
            baseUrlOverride: REDDIT_BASE_URL,
            params: {
              limit: 100,
              raw_json: 1,
              ...(query ? { q: query, include_over_18: "on", sort: "relevance" } : {}),
            },
            headers: {
              "User-Agent": "agentrelay-reddit-relay/1.0",
              Accept: "application/json",
            },
            retries: 1,
          })).data)
        : normalizeAtlassianResources((await nango.proxy({
            method: "GET",
            endpoint: "/oauth/token/accessible-resources",
            connectionId: integration.connectionId,
            providerConfigKey,
            baseUrlOverride: "https://api.atlassian.com",
            retries: 1,
          })).data);
    return NextResponse.json<SuccessBody>(
      { ok: true, resources },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Integration accessible-resources lookup failed:", {
      workspaceId,
      provider: resolved,
      error: message,
    });
    return errorResponse(502, {
      code: "upstream_error",
      message: `Failed to list accessible resources for ${resolved}: ${message}`,
    });
  }
}
