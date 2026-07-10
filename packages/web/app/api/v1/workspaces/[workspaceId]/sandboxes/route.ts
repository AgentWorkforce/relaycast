import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { readBearerToken } from "@/lib/auth/api-token-store";
import {
  mintRuntimeRelayfileCredentials,
  normalizePersonaIntegrationConfigs,
  normalizeRelayfileMountPaths,
  relayfileTriggerIntegrationsFromPersonaIntegrations,
} from "@/lib/integrations/mint-runtime-relayfile-credentials";
import {
  resolvePersonaIntegrations,
  serializeResolvedPersonaIntegrations,
  type PersonaIntegrationConfigWithSource,
} from "@/lib/integrations/persona-integration-resolver";
import { logger } from "@/lib/logger";
import {
  RelayfilePathScopeError,
  relayfilePathsForIntegrations,
  type RelayfileTriggerIntegrations,
} from "@cloud/core/relayfile/path-scopes.js";
import {
  recordWorkforceSandboxCreated,
  recordWorkforceSandboxPathTokenMinted,
} from "./workforce-sandbox-audit";
import {
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  MAX_SANDBOX_TIMEOUT_SECONDS,
  createDaytonaClient,
  isRecord,
  isStringRecord,
  jsonError,
  normalizeOptionalString,
  normalizeTimeoutSeconds,
  provisionSandbox,
  readJsonBody,
  requireWorkspaceSandboxAuth,
  type ErrorResponse,
  type WorkspaceSandboxRouteContext,
} from "./sandbox-utils";

type CreateSandboxBody = {
  purpose: "workforce-deploy";
  personaId: string;
  agentId?: string;
  label?: string;
  env?: Record<string, string>;
  integrations?: Record<string, PersonaIntegrationConfigWithSource>;
  relayfileMountPaths?: string[];
  timeoutSeconds: number;
};

const PERSONA_INTEGRATIONS_ENV = "AGENT_WORKFORCE_PERSONA_INTEGRATIONS";

type CreateSandboxResponse = {
  sandboxId: string;
  status: "running";
  authMode: "proxy";
  organizationId: string | null;
  expiresAt: string;
  execUrl: string;
  filesUrl: string;
};

type PersonaIntegrations = RelayfileTriggerIntegrations;

function parseCreateSandboxBody(value: unknown): CreateSandboxBody | null {
  if (!isRecord(value) || value.purpose !== "workforce-deploy") {
    return null;
  }

  const personaId = normalizeOptionalString(value.personaId);
  if (!personaId) {
    return null;
  }

  const timeoutSeconds = normalizeTimeoutSeconds(value.timeoutSeconds, {
    defaultSeconds: DEFAULT_SANDBOX_TIMEOUT_SECONDS,
    maxSeconds: MAX_SANDBOX_TIMEOUT_SECONDS,
  });
  if (timeoutSeconds === null) {
    return null;
  }

  if (value.env !== undefined && !isStringRecord(value.env)) {
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

  return {
    purpose: "workforce-deploy",
    personaId,
    agentId: normalizeOptionalString(value.agentId),
    label: normalizeOptionalString(value.label),
    env: value.env,
    integrations,
    relayfileMountPaths: value.relayfileMountPaths,
    timeoutSeconds,
  };
}

function normalizePersonaIntegrations(value: unknown): PersonaIntegrations | undefined {
  return relayfileTriggerIntegrationsFromPersonaIntegrations(value);
}

async function readPersonaDefinition(personaId: string): Promise<unknown | null> {
  if (!/^[a-zA-Z0-9._-]+$/.test(personaId)) {
    return null;
  }

  const candidates = [
    join(process.cwd(), "personas", `${personaId}.json`),
    join(
      process.cwd(),
      ".agentworkforce",
      "workforce",
      "personas",
      `${personaId}.json`,
    ),
  ];

  for (const candidate of candidates) {
    try {
      return JSON.parse(await readFile(candidate, "utf8")) as unknown;
    } catch (error) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
      if (code !== "ENOENT") {
        throw error;
      }
    }
  }

  return null;
}

async function deriveRelayfilePathsForPersona(personaId: string): Promise<string[]> {
  const persona = await readPersonaDefinition(personaId);
  if (!isRecord(persona)) {
    return [];
  }

  return relayfilePathsForIntegrations(normalizePersonaIntegrations(persona.integrations));
}

function sandboxUrl(request: NextRequest, pathname: string): string {
  return new URL(pathname, request.url).toString();
}

export async function POST(
  request: NextRequest,
  context: WorkspaceSandboxRouteContext,
) {
  const access = await requireWorkspaceSandboxAuth(request, context);
  if (!access.ok) {
    return access.response;
  }

  const body = parseCreateSandboxBody(await readJsonBody(request));
  if (!body) {
    return jsonError("Invalid request body", "invalid_request", 400);
  }

  const expiresAt = new Date(Date.now() + body.timeoutSeconds * 1000);
  const autoStopInterval = Math.max(1, Math.ceil(body.timeoutSeconds / 60));
  let resolvedPersonaIntegrations: Awaited<ReturnType<typeof resolvePersonaIntegrations>> | null = null;
  if (body.integrations && Object.keys(body.integrations).length > 0) {
    try {
      resolvedPersonaIntegrations = await resolvePersonaIntegrations({
        workspaceId: access.workspaceId,
        deployerUserId: access.auth.userId,
        integrations: body.integrations,
      });
    } catch (error) {
      return jsonError(
        error instanceof Error ? error.message : "Failed to resolve persona integrations",
        "integration_resolution_failed",
        409,
      );
    }
  }
  let envVars: Record<string, string> | undefined = resolvedPersonaIntegrations
    ? {
      ...body.env,
      [PERSONA_INTEGRATIONS_ENV]: JSON.stringify(
        serializeResolvedPersonaIntegrations(resolvedPersonaIntegrations),
      ),
    }
    : (body.env ? { ...body.env } : undefined);
  let relayfilePaths: string[] = [];

  let createdSandboxId: string | null = null;
  let daytonaClient: ReturnType<typeof createDaytonaClient> | null = null;
  try {
    relayfilePaths = body.relayfileMountPaths?.length
      ? normalizeRelayfileMountPaths(body.relayfileMountPaths)
      : await deriveRelayfilePathsForPersona(body.personaId);
    if (relayfilePaths.length > 0) {
      const workspaceToken = readBearerToken(request.headers.get("authorization"));
      if (!workspaceToken) {
        logger.warn(
          "Skipping path-scoped relayfile token mint because bearer token auth is unavailable",
          {
            area: "workforce-sandbox",
            workspaceId: access.workspaceId,
            personaId: body.personaId,
          },
        );
      } else {
        const credentials = await mintRuntimeRelayfileCredentials({
          workspaceId: access.workspaceId,
          workspaceToken,
          relayfileMountPaths: relayfilePaths,
          ttlSeconds: body.timeoutSeconds,
          agentName: body.agentId ?? body.personaId,
          agentId: body.agentId ?? body.personaId,
          auditLogger: logger,
          includeRelayfileUrl: false,
        });
        envVars = envVars ?? {};
        envVars.RELAYFILE_TOKEN = credentials.relayfileToken ?? "";
        envVars.RELAYFILE_MOUNT_PATHS = JSON.stringify(relayfilePaths);
      }
    }
    envVars = {
      ...(envVars ?? {}),
      RELAY_AGENT_NAME: body.env?.RELAY_AGENT_NAME ?? body.agentId ?? body.personaId,
      RELAY_DEFAULT_WORKSPACE: body.env?.RELAY_DEFAULT_WORKSPACE ?? access.workspaceId,
    };

    daytonaClient = createDaytonaClient();
    const { sandbox } = await provisionSandbox({
      client: daytonaClient,
      workspaceId: access.workspaceId,
      userId: access.auth.userId,
      organizationId: access.auth.organizationId,
      source: "workforce-deploy",
      envVars,
      autoStopInterval,
      createTimeoutSeconds: body.timeoutSeconds,
      label: body.label,
      labels: {
        purpose: body.purpose,
        workspaceId: access.workspaceId,
        personaId: body.personaId,
        agentId: body.agentId,
      },
    });
    createdSandboxId = sandbox.id;

    recordWorkforceSandboxCreated({
      workspaceId: access.workspaceId,
      personaId: body.personaId,
      sandboxId: sandbox.id,
      requester: access.auth.userId,
      organizationId:
        typeof sandbox.organizationId === "string" ? sandbox.organizationId : null,
      timeoutSeconds: body.timeoutSeconds,
    });
    if (relayfilePaths.length > 0) {
      recordWorkforceSandboxPathTokenMinted({
        workspaceId: access.workspaceId,
        personaId: body.personaId,
        agentId: body.agentId ?? null,
        sandboxId: sandbox.id,
        requester: access.auth.userId,
        paths: relayfilePaths,
      });
    }

    const basePath =
      `/api/v1/workspaces/${encodeURIComponent(access.workspaceId)}` +
      `/sandboxes/${encodeURIComponent(sandbox.id)}`;

    return NextResponse.json<CreateSandboxResponse>(
      {
        sandboxId: sandbox.id,
        status: "running",
        authMode: "proxy",
        organizationId:
          typeof sandbox.organizationId === "string" ? sandbox.organizationId : null,
        expiresAt: expiresAt.toISOString(),
        execUrl: sandboxUrl(request, `${basePath}/exec`),
        filesUrl: sandboxUrl(request, `${basePath}/files`),
      },
      { status: 201 },
    );
  } catch (error) {
    if (createdSandboxId && daytonaClient) {
      // Roll back the orphaned Daytona sandbox so a transient DB failure
      // doesn't leak billed resources. A best-effort cleanup: if the
      // delete itself fails we log loudly so an operator can sweep.
      try {
        const orphan = await daytonaClient.get(createdSandboxId);
        await daytonaClient.delete(orphan);
      } catch (cleanupError) {
        console.error(
          "[workforce-sandbox] rollback failed for orphaned sandbox",
          createdSandboxId,
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        );
      }
    }
    if (error instanceof RelayfilePathScopeError) {
      return jsonError(error.message, "invalid_persona_integrations", 400);
    }
    console.error(
      "[workforce-sandbox] creation failed:",
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json<ErrorResponse>(
      { error: "Failed to create sandbox", code: "sandbox_create_failed" },
      { status: 503 },
    );
  }
}
