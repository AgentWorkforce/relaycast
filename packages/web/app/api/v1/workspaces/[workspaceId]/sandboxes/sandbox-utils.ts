import { Buffer } from "node:buffer";
import { and, eq, ne } from "drizzle-orm";
import { Daytona } from "@daytonaio/sdk";
import { getSnapshotName } from "@cloud/core/config/snapshot.js";
import { NextRequest, NextResponse } from "next/server";
import { resolveRequestAuth } from "@/lib/auth/request-auth";
import { configureDaytonaFetchFirstAdapter } from "@/lib/daytona-fetch-adapter";
import { resolveServerDaytonaAuthParams } from "@/lib/daytona-auth";
import { getDb } from "@/lib/db";
import { sandboxes } from "@/lib/db/schema";
import { hasWorkspaceAccess } from "@/lib/integrations/integration-route-handler";

export type WorkspaceSandboxRouteContext = {
  params: Promise<{ workspaceId: string; sandboxId?: string }>;
};

export type ErrorResponse = {
  error: string;
  code: string;
};

type AuthResult =
  | {
      ok: true;
      auth: NonNullable<Awaited<ReturnType<typeof resolveRequestAuth>>>;
      workspaceId: string;
      sandboxId?: string;
    }
  | { ok: false; response: NextResponse<ErrorResponse> };

export const DEFAULT_SANDBOX_TIMEOUT_SECONDS = 60 * 60;
export const MAX_SANDBOX_TIMEOUT_SECONDS = 24 * 60 * 60;
export const MAX_CREATE_TIMEOUT_SECONDS = 120;
export const MAX_COMMAND_TIMEOUT_SECONDS = 600;

export function jsonError(
  error: string,
  code: string,
  status: number,
): NextResponse<ErrorResponse> {
  return NextResponse.json({ error, code }, { status });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

export function normalizeOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeTimeoutSeconds(
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

export async function requireWorkspaceSandboxAuth(
  request: NextRequest,
  context: WorkspaceSandboxRouteContext,
): Promise<AuthResult> {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return { ok: false, response: jsonError("Unauthorized", "unauthorized", 401) };
  }

  const { workspaceId, sandboxId } = await context.params;
  if (!workspaceId) {
    return {
      ok: false,
      response: jsonError("Workspace not found", "workspace_not_found", 404),
    };
  }

  if (!hasWorkspaceAccess(auth, workspaceId)) {
    return { ok: false, response: jsonError("Forbidden", "forbidden", 403) };
  }

  return { ok: true, auth, workspaceId, sandboxId };
}

export function resolveDaytonaConfig(): ConstructorParameters<typeof Daytona>[0] {
  const params = resolveServerDaytonaAuthParams();
  if (params.daytonaApiKey) {
    return { apiKey: params.daytonaApiKey };
  }
  return {
    jwtToken: params.daytonaJwtToken,
    organizationId: params.daytonaOrganizationId,
  };
}

export function createDaytonaClient(): Daytona {
  configureDaytonaFetchFirstAdapter();
  return new Daytona(resolveDaytonaConfig());
}

export async function readJsonBody(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function requireSandboxRecord(
  workspaceId: string,
  sandboxId: string | undefined,
): Promise<{ ok: true } | { ok: false; response: NextResponse<ErrorResponse> }> {
  if (!sandboxId) {
    return {
      ok: false,
      response: jsonError("Sandbox not found", "sandbox_not_found", 404),
    };
  }

  // Exclude rows that have already been marked deleted — callers should
  // treat a tombstoned record as "not found" so subsequent exec/files
  // requests against a torn-down sandbox return 404 instead of leaking
  // the DB row's existence.
  const [row] = await getDb()
    .select({ id: sandboxes.id })
    .from(sandboxes)
    .where(
      and(
        eq(sandboxes.id, sandboxId),
        eq(sandboxes.workspaceId, workspaceId),
        ne(sandboxes.status, "deleted"),
      ),
    )
    .limit(1);

  if (!row) {
    return {
      ok: false,
      response: jsonError("Sandbox not found", "sandbox_not_found", 404),
    };
  }

  return { ok: true };
}

export async function markSandboxDeleted(
  workspaceId: string,
  sandboxId: string,
): Promise<void> {
  await getDb()
    .update(sandboxes)
    .set({ status: "deleted", updatedAt: new Date() })
    .where(and(eq(sandboxes.id, sandboxId), eq(sandboxes.workspaceId, workspaceId)));
}

export function decodeBase64(value: string): Buffer | null {
  if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    return null;
  }
  return Buffer.from(value, "base64");
}

export type ProvisionSandboxInput = {
  client: Daytona;
  workspaceId: string;
  userId: string;
  organizationId: string;
  source: "workforce-deploy" | "cloud-agent";
  envVars: Record<string, string> | undefined;
  autoStopInterval: number;
  createTimeoutSeconds: number;
  label?: string;
  labels: Record<string, string | undefined>;
};

export type ProvisionedSandbox = {
  sandbox: Awaited<ReturnType<Daytona["create"]>>;
  insertedAt: Date;
};

export async function provisionSandbox(
  input: ProvisionSandboxInput,
): Promise<ProvisionedSandbox> {
  const cleanLabels: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.labels)) {
    if (typeof value === "string") {
      cleanLabels[key] = value;
    }
  }

  const snapshot = await getSnapshotName();
  const sandbox = await input.client.create(
    {
      snapshot,
      language: "typescript",
      name: input.label,
      envVars: input.envVars,
      autoStopInterval: input.autoStopInterval,
      labels: cleanLabels,
    },
    {
      timeout: Math.min(MAX_CREATE_TIMEOUT_SECONDS, input.createTimeoutSeconds),
    },
  );

  const insertedAt = new Date();
  try {
    await getDb().insert(sandboxes).values({
      id: sandbox.id,
      userId: input.userId,
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      source: input.source,
      status: "running",
      brokerPort: null,
      createdAt: insertedAt,
      updatedAt: insertedAt,
    });
  } catch (insertError) {
    // Roll back the just-created Daytona sandbox so a transient DB
    // failure doesn't leak billed resources keyed to a row that never
    // got written. Mirrors the legacy inline behaviour at the caller.
    try {
      const orphan = await input.client.get(sandbox.id);
      await input.client.delete(orphan);
    } catch (cleanupError) {
      console.error(
        "[workforce-sandbox] rollback failed for orphaned sandbox",
        sandbox.id,
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      );
    }
    throw insertError;
  }

  return { sandbox, insertedAt };
}
