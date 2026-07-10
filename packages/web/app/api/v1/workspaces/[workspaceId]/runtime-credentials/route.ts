import { NextRequest, NextResponse } from "next/server";
import { resolveRequestAuth, type RequestAuth } from "@/lib/auth/request-auth";
import {
  mintRuntimeRelayfileCredentials,
  normalizePersonaIntegrationConfigs,
  resolveRuntimeRelayfileMountPaths,
} from "@/lib/integrations/mint-runtime-relayfile-credentials";
import type {
  PersonaIntegrationConfigWithSource,
} from "@/lib/integrations/persona-integration-config";
import { logger } from "@/lib/logger";
import { isValidWorkspaceId } from "@/lib/relay-workspaces";
import { createCloudWorkspaceRegistry } from "@/lib/workspace-registry";
import { resolveAppWorkspaceByRelayWorkspaceId } from "@/lib/workspaces/relay-workspace-binding";
import { RelayfilePathScopeError } from "@cloud/core/relayfile/path-scopes.js";

type WorkspaceRuntimeCredentialsRouteContext = {
  params: Promise<{ workspaceId: string }>;
};

type ErrorResponse = {
  error: string;
  code: string;
};

type AuthResult =
  | {
      ok: true;
      auth: RequestAuth;
      workspaceId: string;
    }
  | { ok: false; response: NextResponse<ErrorResponse> };

type RuntimeCredentialsBody = {
  personaId: string;
  agentId?: string;
  agent?: unknown;
  integrations?: Record<string, PersonaIntegrationConfigWithSource>;
  relayfileMountPaths?: string[];
  ttlSeconds: number;
  delegationTtlSeconds: number;
};

const DEFAULT_SANDBOX_TIMEOUT_SECONDS = 60 * 60;
const MAX_SANDBOX_TIMEOUT_SECONDS = 24 * 60 * 60;
const DEFAULT_DELEGATION_TTL_SECONDS = 24 * 60 * 60;
const MAX_DELEGATION_TTL_SECONDS = 7 * 24 * 60 * 60;
const RELAYAUTH_WORKSPACE_TOKEN_HEADER = "x-relayauth-workspace-token";

function jsonError(
  error: string,
  code: string,
  status: number,
): NextResponse<ErrorResponse> {
  return NextResponse.json({ error, code }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeTimeoutSeconds(
  value: unknown,
  options: { defaultSeconds: number; maxSeconds: number },
): number | null {
  if (value === undefined || value === null) {
    return options.defaultSeconds;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > options.maxSeconds
  ) {
    return null;
  }
  return value;
}

async function readJsonBody(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function readRelayAuthWorkspaceToken(request: NextRequest): string | null {
  return normalizeOptionalString(request.headers.get(RELAYAUTH_WORKSPACE_TOKEN_HEADER)) ?? null;
}

function delegationNotAfterFromNow(ttlSeconds: number): string {
  return new Date(Date.now() + ttlSeconds * 1000).toISOString();
}

function hasWorkspaceAccess(
  auth: RequestAuth,
  workspaceId: string,
  relayWorkspaceId?: string,
): boolean {
  if (relayWorkspaceId && auth.workspaceId === relayWorkspaceId) {
    return true;
  }
  if (auth.source === "session") {
    return auth.context?.workspaces.some((workspace) => workspace.id === workspaceId) ?? false;
  }
  return auth.workspaceId === workspaceId;
}

async function resolveRuntimeWorkspace(rawWorkspaceId: string): Promise<{
  accessWorkspaceId: string;
  relayWorkspaceId?: string;
  relayfileWorkspaceId: string;
} | null> {
  const workspaceId = rawWorkspaceId.trim();
  if (!workspaceId) {
    return null;
  }

  if (!isValidWorkspaceId(workspaceId)) {
    return {
      accessWorkspaceId: workspaceId,
      relayfileWorkspaceId: workspaceId,
    };
  }

  const binding = await resolveAppWorkspaceByRelayWorkspaceId(workspaceId).catch(() => ({
    appWorkspaceId: null,
    organizationId: null,
  }));
  const { registry } = createCloudWorkspaceRegistry();
  const relayWorkspace = await registry.get(workspaceId);
  if (!relayWorkspace) {
    return null;
  }

  return {
    accessWorkspaceId: binding.appWorkspaceId ?? workspaceId,
    relayWorkspaceId: workspaceId,
    relayfileWorkspaceId: relayWorkspace.relayfileWorkspaceId,
  };
}

async function requireRuntimeCredentialsAuth(
  request: NextRequest,
  context: WorkspaceRuntimeCredentialsRouteContext,
): Promise<AuthResult> {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return { ok: false, response: jsonError("Unauthorized", "unauthorized", 401) };
  }

  const { workspaceId: rawWorkspaceId } = await context.params;
  const runtimeWorkspace = await resolveRuntimeWorkspace(rawWorkspaceId);
  if (!runtimeWorkspace) {
    return {
      ok: false,
      response: jsonError("Workspace not found", "workspace_not_found", 404),
    };
  }

  if (
    !hasWorkspaceAccess(
      auth,
      runtimeWorkspace.accessWorkspaceId,
      runtimeWorkspace.relayWorkspaceId,
    )
  ) {
    return { ok: false, response: jsonError("Forbidden", "forbidden", 403) };
  }

  return { ok: true, auth, workspaceId: runtimeWorkspace.relayfileWorkspaceId };
}

function parseRuntimeCredentialsBody(value: unknown): RuntimeCredentialsBody | null {
  if (!isRecord(value)) {
    return null;
  }

  const personaId = normalizeOptionalString(value.personaId);
  if (!personaId) {
    return null;
  }

  const ttlSeconds = normalizeTimeoutSeconds(value.ttlSeconds, {
    defaultSeconds: DEFAULT_SANDBOX_TIMEOUT_SECONDS,
    maxSeconds: MAX_SANDBOX_TIMEOUT_SECONDS,
  });
  if (ttlSeconds === null) {
    return null;
  }
  const delegationTtlSeconds = normalizeTimeoutSeconds(value.delegationTtlSeconds, {
    defaultSeconds: Math.max(DEFAULT_DELEGATION_TTL_SECONDS, ttlSeconds),
    maxSeconds: MAX_DELEGATION_TTL_SECONDS,
  });
  if (delegationTtlSeconds === null || delegationTtlSeconds < ttlSeconds) {
    return null;
  }

  if ("relayfilePaths" in value) {
    return null;
  }
  if (
    value.relayfileMountPaths !== undefined &&
    (!Array.isArray(value.relayfileMountPaths) ||
      !value.relayfileMountPaths.every((entry) => typeof entry === "string"))
  ) {
    return null;
  }

  const integrations = normalizePersonaIntegrationConfigs(value.integrations);
  if (integrations === null) {
    return null;
  }
  if (value.agent !== undefined && !isRecord(value.agent)) {
    return null;
  }

  return {
    personaId,
    agentId: normalizeOptionalString(value.agentId),
    ...(value.agent !== undefined ? { agent: value.agent } : {}),
    integrations,
    relayfileMountPaths: value.relayfileMountPaths,
    ttlSeconds,
    delegationTtlSeconds,
  };
}

export async function POST(
  request: NextRequest,
  context: WorkspaceRuntimeCredentialsRouteContext,
) {
  const access = await requireRuntimeCredentialsAuth(request, context);
  if (!access.ok) {
    return access.response;
  }

  const body = parseRuntimeCredentialsBody(await readJsonBody(request));
  if (!body) {
    return jsonError("Invalid request body", "invalid_request", 400);
  }

  let relayfileMountPaths: string[];
  try {
    relayfileMountPaths = resolveRuntimeRelayfileMountPaths({
      relayfileMountPaths: body.relayfileMountPaths,
      integrations: body.integrations,
      agent: body.agent,
    });
  } catch (error) {
    if (error instanceof RelayfilePathScopeError) {
      return jsonError(error.message, "invalid_persona_integrations", 400);
    }
    throw error;
  }

  const workspaceToken = readRelayAuthWorkspaceToken(request);
  if (relayfileMountPaths.length > 0 && !workspaceToken) {
    return jsonError(
      "RelayAuth workspace token required",
      "relayauth_workspace_token_required",
      401,
    );
  }
  if (workspaceToken?.startsWith("relay_pa_")) {
    return jsonError(
      "Relayfile path tokens cannot mint runtime credentials",
      "relayfile_path_token_not_allowed",
      403,
    );
  }
  if (workspaceToken && !workspaceToken.startsWith("relay_ws_")) {
    return jsonError(
      "RelayAuth workspace token must be a relay_ws_ token",
      "relayauth_workspace_token_invalid",
      403,
    );
  }

  const credentials = await mintRuntimeRelayfileCredentials({
    workspaceId: access.workspaceId,
    workspaceToken,
    relayfileMountPaths,
    ttlSeconds: body.ttlSeconds,
    delegationNotAfter: relayfileMountPaths.length > 0
      ? delegationNotAfterFromNow(body.delegationTtlSeconds)
      : null,
    agentName: body.agentId ?? body.personaId,
    agentId: body.agentId ?? body.personaId,
    auditLogger: logger,
  });

  return NextResponse.json(credentials);
}
