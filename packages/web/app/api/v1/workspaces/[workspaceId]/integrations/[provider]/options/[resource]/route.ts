import { NextRequest, NextResponse } from "next/server";
import { resolveRequestAuth } from "@/lib/auth/request-auth";
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
import {
  listWorkspaceIntegrationsByProviderAlias,
  type WorkspaceIntegrationRecord,
} from "@/lib/integrations/workspace-integrations";
import {
  hasWorkspaceIntegrationReadAccess,
  resolveWorkspaceIntegrationIdentity,
} from "@/lib/workspaces/workspace-integration-identity";

// Cross-repo entry point for the deploy-time "pick a teammate / team / channel"
// onboarding flow. After OAuth connect, the CLI calls this route so the
// operator selects a value from a live list instead of pasting a raw id
// (BENJAMIN=U…, LINEAR_TEAM_ID=…, SLACK_CHANNEL=C…). It mirrors the
// sibling `accessible-resources` route (auth + connection resolution) but
// drives the list off the dedicated Nango list-* actions and returns a
// provider-agnostic `{ value, label, hint? }` contract the picker renders
// directly.
//
// The (provider, resource) matrix is intentionally explicit: only integrations
// that ship list-* actions are exposed here, so unsupported providers /
// resources get a typed 400 rather than a confusing upstream error.

type RouteContext = {
  params: Promise<{ workspaceId: string; provider: string; resource: string }>;
};

type Option = {
  value: string;
  label: string;
  hint?: string;
};

type SuccessBody = {
  ok: true;
  options: Option[];
  nextCursor?: string;
};

type ErrorBody = {
  ok: false;
  error: string;
  code?: string;
};

// (provider, resource) -> Nango action name. Keep in sync with the action
// files registered in `nango-integrations/index.ts`.
const RESOURCE_ACTIONS: Partial<
  Record<WorkspaceIntegrationProvider, Record<string, string>>
> = {
  github: { users: "list-users" },
  slack: { users: "list-users", channels: "list-channels" },
  linear: {
    teams: "list-teams",
    projects: "list-projects",
    labels: "list-labels",
    assignees: "list-assignees",
  },
  daytona: { organizations: "list-organizations" },
};

const DEFAULT_ACTION_LIMIT = 50;
const MIN_ACTION_LIMIT = 1;
const MAX_ACTION_LIMIT = 200;

type ActionInput = {
  query?: string;
  cursor?: string;
  limit: number;
};

function errorResponse(
  status: number,
  body: { code: string; message: string },
): NextResponse<ErrorBody> {
  return NextResponse.json<ErrorBody>(
    { ok: false, error: body.message, code: body.code },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readLimit(value: string | null): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_ACTION_LIMIT) {
    return DEFAULT_ACTION_LIMIT;
  }
  return Math.min(parsed, MAX_ACTION_LIMIT);
}

function buildActionInput(searchParams: URLSearchParams): ActionInput {
  const query = readString(searchParams.get("query"));
  const cursor = readString(searchParams.get("cursor"));
  return {
    ...(query ? { query } : {}),
    ...(cursor ? { cursor } : {}),
    limit: readLimit(searchParams.get("limit")),
  };
}

// Each list-* action returns a single array keyed by the resource name. We
// re-shape it into the picker contract here so the SDK/CLI never needs to
// know the upstream record shapes, and so we can evolve the actions without
// breaking consumers.
function normalizeOptions(
  provider: WorkspaceIntegrationProvider,
  resource: string,
  raw: unknown,
): Option[] {
  if (!raw || typeof raw !== "object") {
    return [];
  }
  const record = raw as Record<string, unknown>;
  const out: Option[] = [];

  if (resource === "users") {
    for (const entry of asArray(record.users)) {
      if (provider === "github") {
        const login = readString(entry.login);
        if (!login) continue;
        out.push({ value: login, label: login });
        continue;
      }

      const id = readString(entry.id);
      if (!id) continue;
      const label =
        readString(entry.real_name) ??
        readString(entry.display_name) ??
        readString(entry.name) ??
        id;
      const hint = readString(entry.email);
      out.push({ value: id, label, ...(hint ? { hint } : {}) });
    }
    return out;
  }

  if (resource === "channels") {
    for (const entry of asArray(record.channels)) {
      const id = readString(entry.id);
      if (!id) continue;
      const name = readString(entry.name) ?? id;
      out.push({
        value: id,
        label: `#${name}`,
        ...(entry.is_private === true ? { hint: "private" } : {}),
      });
    }
    return out;
  }

  if (resource === "teams") {
    for (const entry of asArray(record.teams)) {
      const id = readString(entry.id);
      if (!id) continue;
      const label = readString(entry.name) ?? id;
      const hint = readString(entry.key);
      out.push({ value: id, label, ...(hint ? { hint } : {}) });
    }
    return out;
  }

  if (resource === "projects") {
    for (const entry of asArray(record.projects)) {
      const id = readString(entry.id);
      if (!id) continue;
      const label = readString(entry.name) ?? id;
      const hint = readString(entry.state) ?? readString(entry.description);
      out.push({ value: id, label, ...(hint ? { hint } : {}) });
    }
    return out;
  }

  if (resource === "labels") {
    for (const entry of asArray(record.labels)) {
      const id = readString(entry.id);
      if (!id) continue;
      const label = readString(entry.name) ?? id;
      const hint = readString(entry.color);
      out.push({ value: id, label, ...(hint ? { hint } : {}) });
    }
    return out;
  }

  if (resource === "assignees") {
    for (const entry of asArray(record.assignees)) {
      const id = readString(entry.id);
      if (!id) continue;
      const label =
        readString(entry.displayName) ?? readString(entry.name) ?? id;
      const hint = readString(entry.email);
      out.push({ value: id, label, ...(hint ? { hint } : {}) });
    }
    return out;
  }

  if (resource === "organizations") {
    for (const entry of asArray(record.organizations)) {
      const id = readString(entry.id);
      if (!id) continue;
      const label = readString(entry.name) ?? id;
      out.push({ value: id, label });
    }
    return out;
  }

  return out;
}

function readNextCursor(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  return readString((raw as Record<string, unknown>).nextCursor);
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === "object",
  );
}

async function findWorkspaceIntegrationForOptions(
  workspaceIds: readonly string[],
  provider: WorkspaceIntegrationProvider,
): Promise<WorkspaceIntegrationRecord | null> {
  for (const workspaceId of workspaceIds) {
    const integrations = await listWorkspaceIntegrationsByProviderAlias(
      workspaceId,
      provider,
    );
    if (integrations.length > 0) {
      return (
        integrations.find((integration) => !integration.name) ??
        integrations[0] ??
        null
      );
    }
  }
  return null;
}

function getIntegrationProviderConfigKey(
  integration: WorkspaceIntegrationRecord,
  fallbackProvider: WorkspaceIntegrationProvider,
): string {
  if (integration.providerConfigKey) {
    return integration.providerConfigKey;
  }

  const rowProvider = resolveWorkspaceIntegrationProvider(integration.provider);
  return getProviderConfigKey(rowProvider ?? fallbackProvider);
}

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await resolveRequestAuth(request);
  const { workspaceId, provider, resource } = await context.params;

  if (!auth) {
    return errorResponse(401, { code: "unauthorized", message: "Unauthorized" });
  }

  const identity = await resolveWorkspaceIntegrationIdentity(workspaceId);
  const integrationWorkspaceIds = [
    identity.relayWorkspaceId,
    ...identity.candidateWorkspaceIds,
  ].filter((entry, index, entries) => entry && entries.indexOf(entry) === index);

  if (!hasWorkspaceIntegrationReadAccess(auth, identity)) {
    return errorResponse(403, { code: "forbidden", message: "Forbidden" });
  }

  const resolved = resolveWorkspaceIntegrationProvider(provider);
  if (!resolved || !isWorkspaceIntegrationProvider(resolved)) {
    return errorResponse(404, {
      code: "unknown_provider",
      message: "Integration provider not found",
    });
  }

  const actionName = RESOURCE_ACTIONS[resolved]?.[resource];
  if (!actionName) {
    return errorResponse(400, {
      code: "unsupported_resource",
      message: `Provider "${resolved}" does not expose a "${resource}" option list.`,
    });
  }

  if (!getNangoSecretKey()) {
    return errorResponse(501, {
      code: "backend_not_configured",
      message: "Nango backend not configured",
    });
  }

  const integration = await findWorkspaceIntegrationForOptions(
    integrationWorkspaceIds,
    resolved,
  );
  if (!integration) {
    return errorResponse(404, {
      code: "integration_not_found",
      message: `No ${resolved} integration is connected for this workspace`,
    });
  }

  try {
    const nango = getNangoClient();
    const providerConfigKey = getIntegrationProviderConfigKey(
      integration,
      resolved,
    );
    const actionInput = buildActionInput(request.nextUrl.searchParams);
    const result = await nango.triggerAction(
      providerConfigKey,
      integration.connectionId,
      actionName,
      actionInput,
    );
    const options = normalizeOptions(resolved, resource, result);
    const nextCursor = readNextCursor(result);
    return NextResponse.json<SuccessBody>(
      { ok: true, options, ...(nextCursor ? { nextCursor } : {}) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Integration options lookup failed:", {
      workspaceId: integration.workspaceId,
      requestedWorkspaceId: workspaceId,
      provider: resolved,
      resource,
      error: message,
    });
    return errorResponse(502, {
      code: "upstream_error",
      message: `Failed to list ${resource} for ${resolved}: ${message}`,
    });
  }
}
