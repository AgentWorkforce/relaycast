import { Hono } from "hono";
import type { AppContext, AppEnv } from "../env.js";
import type { FileReadResponse } from "@relayfile/sdk";
import {
  authorizeBearer,
  authorizeWebSocketToken,
  authorizeWebSocketTokenCapability,
  forwardToWorkspaceDO,
  jsonError,
  requireBearerCapabilityScope,
  requireBearerScopeForPath,
  requireCorrelationId,
  scopeMatchesPath,
} from "../middleware/auth.js";
import { fetchWorkspaceDOWithBackpressure } from "../workspace-do-backpressure.js";
import { withWorkspaceWriteAdmission } from "../middleware/workspace-write-admission.js";
import { emitMetric } from "../durable-objects/metrics.js";
import { fanoutShardNamesForReadPath } from "../durable-objects/sharding.js";
import {
  resolveVfsPlaneRoute,
  vfsPlaneLogLabels,
} from "../durable-objects/vfs-plane.js";
import {
  handleExportFromWorker,
  loadBodyFromR2,
  metadataToFileReadResponse,
  type WorkerFileReadMetadata,
} from "./export.js";
import { getWorkspaceStubForPath } from "./shard-routing.js";
import {
  WriteBodyOverflowError,
  effectiveWriteLimitFromConfig,
  readJsonWithLimit,
  rejectJsonWriteContentLength,
} from "../write-body-size-guard.js";

export const fsRoutes = new Hono<AppEnv>();

const MAX_BULK_READ_FILES = 100;

function normalizeRoutePath(path: string | undefined): string {
  const trimmed = path?.trim() ?? "";
  return trimmed || "/";
}

function optionalQueryPath(c: AppContext): string | undefined {
  const rawPath = c.req.query("path") ?? c.req.query("pathPrefix");
  const normalized = normalizeRoutePath(rawPath);
  return normalized === "/" ? undefined : normalized;
}

function exportPath(c: AppContext): string {
  return normalizeRoutePath(c.req.query("pathPrefix") || c.req.query("path"));
}

function normalizeWeakEtag(value: string): string {
  const trimmed = value.trim();
  const withoutWeak = trimmed.toLowerCase().startsWith("w/")
    ? trimmed.slice(2).trim()
    : trimmed;
  return withoutWeak.replace(/^"|"$/g, "");
}

function requestHasMatchingEtag(request: Request, revision: string): boolean {
  const header = request.headers.get("If-None-Match");
  if (!header) {
    return false;
  }
  return header
    .split(",")
    .map(normalizeWeakEtag)
    .some((etag) => etag === "*" || etag === revision);
}

function serializeAuthClaims(
  claims: Awaited<ReturnType<typeof authorizeBearer>>,
): AppEnv["Variables"]["authClaims"] {
  return {
    workspaceId: claims.workspaceId,
    agentName: claims.agentName,
    scopes: [...claims.scopes],
    exp: claims.exp,
  };
}

async function readRouteSizeCappedJson<T>(
  c: AppContext,
  request: Request,
): Promise<{ body: T } | { response: Response }> {
  const limit = effectiveWriteLimitFromConfig(c.env.RELAYFILE_MAX_WRITE_BYTES);
  const rejection = rejectJsonWriteContentLength(request, limit);
  if (rejection) {
    return {
      response: jsonError(
        c,
        rejection.status,
        rejection.code,
        rejection.message,
      ),
    };
  }

  try {
    return { body: await readJsonWithLimit<T>(request, limit) };
  } catch (error) {
    if (error instanceof WriteBodyOverflowError) {
      return {
        response: jsonError(c, 413, "payload_too_large", error.message),
      };
    }
    return {
      response: jsonError(c, 400, "bad_request", "invalid json body"),
    };
  }
}

async function bulkWritePaths(
  c: AppContext,
): Promise<{ paths: string[] } | { response: Response }> {
  const guarded = await readRouteSizeCappedJson<unknown>(
    c,
    c.req.raw.clone() as unknown as Request,
  );
  if ("response" in guarded) {
    return guarded;
  }
  const body = guarded.body;
  if (
    body === null ||
    typeof body !== "object" ||
    !Array.isArray((body as { files?: unknown }).files)
  ) {
    return { paths: [] };
  }
  return {
    paths: (body as { files: Array<{ path?: unknown }> }).files.map((file) =>
      typeof file?.path === "string" ? normalizeRoutePath(file.path) : "/",
    ),
  };
}

async function readBulkReadBody(
  c: AppContext,
  request: Request,
): Promise<{ body: BulkReadRequestBody } | { response: Response }> {
  try {
    return {
      body: await readJsonWithLimit<BulkReadRequestBody>(request, 64 * 1024),
    };
  } catch (error) {
    if (error instanceof WriteBodyOverflowError) {
      return {
        response: jsonError(c, 413, "payload_too_large", error.message),
      };
    }
    return {
      response: jsonError(c, 400, "bad_request", "invalid json body"),
    };
  }
}

async function bulkReadPaths(
  c: AppContext,
): Promise<{ paths: string[] } | { response: Response }> {
  const guarded = await readBulkReadBody(
    c,
    c.req.raw.clone() as unknown as Request,
  );
  if ("response" in guarded) {
    return guarded;
  }
  return parseBulkReadPaths(c, guarded.body);
}

function requireBearerScopeForBulkFiles(requiredScope: string) {
  return async (c: AppContext, next: () => Promise<void>) => {
    try {
      const claims = await authorizeBearer(
        c.req.header("Authorization"),
        c.env,
        c.req.param("workspaceId") ?? "",
        "",
      );
      let authorized = scopeMatchesPath(claims, requiredScope, "");
      if (!authorized) {
        const pathsResult = await bulkWritePaths(c);
        if ("response" in pathsResult) {
          return pathsResult.response;
        }
        const paths = pathsResult.paths;
        authorized =
          paths.length > 0 &&
          paths.every((path) => scopeMatchesPath(claims, requiredScope, path));
      }
      if (!authorized) {
        return jsonError(
          c,
          403,
          "forbidden",
          `missing required scope: ${requiredScope}`,
        );
      }
      c.set("authClaims", serializeAuthClaims(claims));
      await next();
    } catch (error) {
      if (error instanceof SyntaxError) {
        return jsonError(c, 400, "bad_request", "invalid json body");
      }
      const authError = error as {
        status?: number;
        code?: string;
        message?: string;
      };
      if (typeof authError.status !== "number") {
        return jsonError(
          c,
          500,
          "internal_error",
          authError.message ?? "bulk authorization failed",
        );
      }
      return jsonError(
        c,
        authError.status,
        authError.code ?? "forbidden",
        authError.message ?? `missing required scope: ${requiredScope}`,
      );
    }
  };
}

function requireBearerScopeForBulkReadFiles(requiredScope: string) {
  return async (c: AppContext, next: () => Promise<void>) => {
    try {
      const claims = await authorizeBearer(
        c.req.header("Authorization"),
        c.env,
        c.req.param("workspaceId") ?? "",
        "",
      );
      let authorized = scopeMatchesPath(claims, requiredScope, "");
      if (!authorized) {
        const pathsResult = await bulkReadPaths(c);
        if ("response" in pathsResult) {
          return pathsResult.response;
        }
        const paths = pathsResult.paths;
        authorized =
          paths.length > 0 &&
          paths.every((path) => scopeMatchesPath(claims, requiredScope, path));
      }
      if (!authorized) {
        return jsonError(
          c,
          403,
          "forbidden",
          `missing required scope: ${requiredScope}`,
        );
      }
      c.set("authClaims", serializeAuthClaims(claims));
      await next();
    } catch (error) {
      const authError = error as {
        status?: number;
        code?: string;
        message?: string;
      };
      if (typeof authError.status !== "number") {
        return jsonError(
          c,
          500,
          "internal_error",
          authError.message ?? "bulk-read authorization failed",
        );
      }
      return jsonError(
        c,
        authError.status,
        authError.code ?? "forbidden",
        authError.message ?? `missing required scope: ${requiredScope}`,
      );
    }
  };
}

function requireBearerScopeForOptionalPath(
  requiredScope: string,
  pathForRequest: (c: AppContext) => string | undefined,
) {
  return async (c: AppContext, next: () => Promise<void>) => {
    const path = pathForRequest(c);
    const middleware =
      path === undefined
        ? requireBearerCapabilityScope(requiredScope)
        : requireBearerScopeForPath(requiredScope, () => path);
    return middleware(c, next);
  };
}

fsRoutes.get(
  "/v1/workspaces/:workspaceId/fs/tree",
  requireBearerScopeForOptionalPath("fs:read", optionalQueryPath),
  requireCorrelationId(),
  async (c) => handleTreeFromWorker(c, c.req.param("workspaceId")),
);

async function handleTreeFromWorker(
  c: AppContext,
  workspaceId: string,
): Promise<Response> {
  const path = optionalQueryPath(c);
  if (!path) {
    return forwardToWorkspaceDO(c, workspaceId);
  }
  if (fanoutShardNamesForReadPath(path).length > 0) {
    return forwardToWorkspaceDO(c, workspaceId);
  }

  emitWorkerVfsPlaneResolvedMetric(workspaceId, path, "tree_read_worker");
  const { stub } = await getWorkspaceStubForPath(c, workspaceId, path, {
    operation: "tree_read",
  });
  return forwardToWorkspaceStub(c, workspaceId, stub);
}

fsRoutes.get("/v1/workspaces/:workspaceId/fs/ws", async (c) => {
  const upgrade = c.req.header("Upgrade")?.toLowerCase();
  if (upgrade !== "websocket") {
    return c.text("Expected WebSocket upgrade", 426);
  }

  try {
    const paths = (c.req.queries("path") ?? []).map((path) =>
      normalizeRoutePath(path),
    );
    const firstPath = paths[0] ?? "/";
    const claims =
      firstPath === "/"
        ? await authorizeWebSocketTokenCapability(
            c,
            c.req.param("workspaceId"),
            "fs:read",
          )
        : await authorizeWebSocketToken(
            c,
            c.req.param("workspaceId"),
            "fs:read",
            firstPath,
          );
    for (const path of paths.slice(1)) {
      if (path === "/") {
        continue;
      }
      if (!scopeMatchesPath(claims, "fs:read", path)) {
        return jsonError(
          c,
          403,
          "forbidden",
          "missing required scope: fs:read",
          "",
        );
      }
    }
  } catch (error) {
    const authError = error as {
      status: number;
      code: string;
      message: string;
    };
    return jsonError(
      c,
      authError.status,
      authError.code,
      authError.message,
      "",
    );
  }

  return forwardToWorkspaceDO(c, c.req.param("workspaceId"), "/ws");
});

fsRoutes.post(
  "/v1/workspaces/:workspaceId/fs/bulk",
  requireBearerScopeForBulkFiles("fs:write"),
  requireCorrelationId(),
  async (c) => {
    const workspaceId = c.req.param("workspaceId");
    return withWorkspaceWriteAdmission(c, workspaceId, "fs_bulk", () =>
      handleBulkWriteFromWorker(c, workspaceId),
    );
  },
);

fsRoutes.post(
  "/v1/workspaces/:workspaceId/fs/bulk-read",
  requireBearerScopeForBulkReadFiles("fs:read"),
  requireCorrelationId(),
  async (c) => handleBulkReadFromWorker(c, c.req.param("workspaceId")),
);

fsRoutes.get(
  "/v1/workspaces/:workspaceId/fs/export",
  requireBearerScopeForPath("fs:read", exportPath),
  requireCorrelationId(),
  // Hardening item 1: export is served by the parent Worker, NOT the DO.
  // The DO returns metadata-only manifest pages; the Worker streams R2
  // bodies directly so the DO heap never holds a file body during export.
  async (c) => handleExportFromWorker(c, c.req.param("workspaceId")),
);

fsRoutes.get(
  "/v1/workspaces/:workspaceId/fs/file",
  requireBearerScopeForPath(
    "fs:read",
    (c) => c.req.query("path")?.trim() ?? "",
  ),
  requireCorrelationId(),
  async (c) => handleReadFileFromWorker(c, c.req.param("workspaceId")),
);

fsRoutes.put(
  "/v1/workspaces/:workspaceId/fs/file",
  requireBearerScopeForPath(
    "fs:write",
    (c) => c.req.query("path")?.trim() ?? "",
  ),
  requireCorrelationId(),
  async (c) => {
    const workspaceId = c.req.param("workspaceId");
    return withWorkspaceWriteAdmission(c, workspaceId, "fs_file_put", () =>
      forwardToWorkspaceDO(c, workspaceId),
    );
  },
);

fsRoutes.delete(
  "/v1/workspaces/:workspaceId/fs/file",
  requireBearerScopeForPath(
    "fs:write",
    (c) => c.req.query("path")?.trim() ?? "",
  ),
  requireCorrelationId(),
  async (c) => {
    const workspaceId = c.req.param("workspaceId");
    return withWorkspaceWriteAdmission(c, workspaceId, "fs_file_delete", () =>
      forwardToWorkspaceDO(c, workspaceId),
    );
  },
);

fsRoutes.get(
  "/v1/workspaces/:workspaceId/fs/events",
  requireBearerCapabilityScope("fs:read"),
  requireCorrelationId(),
  async (c) => forwardToWorkspaceDO(c, c.req.param("workspaceId")),
);

fsRoutes.get(
  "/v1/workspaces/:workspaceId/fs/changes",
  requireBearerCapabilityScope("fs:read"),
  requireCorrelationId(),
  async (c) => forwardToWorkspaceDO(c, c.req.param("workspaceId")),
);

fsRoutes.get(
  "/v1/workspaces/:workspaceId/fs/changes/resource",
  requireBearerCapabilityScope("fs:read"),
  requireCorrelationId(),
  async (c) => forwardToWorkspaceDO(c, c.req.param("workspaceId")),
);

fsRoutes.get(
  "/v1/workspaces/:workspaceId/fs/query",
  requireBearerScopeForOptionalPath("fs:read", optionalQueryPath),
  requireCorrelationId(),
  async (c) => forwardToWorkspaceDO(c, c.req.param("workspaceId")),
);

async function handleReadFileFromWorker(
  c: Parameters<typeof handleExportFromWorker>[0],
  workspaceId: string,
): Promise<Response> {
  const path = c.req.query("path") ?? "";
  if (!path.trim()) {
    return jsonError(c, 400, "bad_request", "missing path");
  }
  emitWorkerVfsPlaneResolvedMetric(workspaceId, path, "file_read_worker");

  const metadataResponse = await fetchReadMetadata(c, workspaceId, path);
  if (!metadataResponse.ok) {
    return metadataResponse;
  }

  const metadata = (await metadataResponse.json()) as WorkerFileReadMetadata;
  if (requestHasMatchingEtag(c.req.raw, metadata.revision)) {
    emitMetric("relayfile_worker_fs_file_not_modified_total", 1, {
      workspace_id: workspaceId,
    });
    return new Response(null, {
      status: 304,
      headers: { ETag: metadata.revision },
    });
  }
  const content = await loadBodyFromR2(c, metadata);
  return c.json(metadataToFileReadResponse(metadata, content), 200, {
    ETag: metadata.revision,
  });
}

type BulkReadRequestBody = {
  paths?: unknown;
  files?: unknown;
};

type BulkWriteRouteBody = Record<string, unknown> & {
  files?: unknown;
};

type BulkReadFileResult =
  | (FileReadResponse & { contentHash?: string })
  | {
      path: string;
      error: {
        status: number;
        code: string;
        message: string;
      };
    };

type BulkWriteAggregate = {
  written: number;
  errorCount: number;
  errors: unknown[];
  correlationId?: unknown;
  dedupedFiles?: unknown[];
  bytesWritten?: number;
  syncCount?: number;
  fileCountDelta?: number;
  bytesStoredDelta?: number;
  operationCountDelta?: number;
};

type BulkWriteShardGroup = {
  stub: DurableObjectStub;
  files: unknown[];
};

async function routeBulkWriteFile(
  c: Parameters<typeof handleExportFromWorker>[0],
  workspaceId: string,
  file: unknown,
): Promise<{ key: string; stub: DurableObjectStub; file: unknown }> {
  const path =
    file !== null &&
    typeof file === "object" &&
    typeof (file as { path?: unknown }).path === "string"
      ? normalizeRoutePath((file as { path: string }).path)
      : "/";
  const { stub, route } = await getWorkspaceStubForPath(c, workspaceId, path, {
    operation: "bulk_write",
  });
  return {
    key: route?.shardKey ?? `workspace:${workspaceId}`,
    stub,
    file,
  };
}

async function handleBulkWriteFromWorker(
  c: Parameters<typeof handleExportFromWorker>[0],
  workspaceId: string,
): Promise<Response> {
  const guarded = await readRouteSizeCappedJson<BulkWriteRouteBody>(
    c,
    c.req.raw.clone() as unknown as Request,
  );
  if ("response" in guarded) {
    return guarded.response;
  }

  const files = Array.isArray(guarded.body.files) ? guarded.body.files : null;
  if (!files || files.length === 0) {
    return forwardToWorkspaceDO(c, workspaceId);
  }

  const groups = new Map<string, BulkWriteShardGroup>();
  const routedFiles = await Promise.all(
    files.map((file) => routeBulkWriteFile(c, workspaceId, file)),
  );
  for (const { key, stub, file } of routedFiles) {
    const group = groups.get(key);
    if (group) {
      group.files.push(file);
    } else {
      groups.set(key, { stub, files: [file] });
    }
  }

  if (groups.size === 1) {
    const [group] = groups.values();
    return forwardToWorkspaceStub(c, workspaceId, group.stub);
  }

  const aggregate: BulkWriteAggregate = {
    written: 0,
    errorCount: 0,
    errors: [],
  };
  const responses = await Promise.all(
    Array.from(groups.values(), (group) =>
      forwardToWorkspaceStub(
        c,
        workspaceId,
        group.stub,
        new Request(c.req.url, {
          method: "POST",
          headers: c.req.raw.headers,
          body: JSON.stringify({
            ...guarded.body,
            files: group.files,
          }),
        }),
      ),
    ),
  );
  for (const response of responses) {
    if (!response.ok) {
      return response;
    }
    mergeBulkWriteAggregate(aggregate, await response.json());
  }

  return c.json(aggregate, 202);
}

async function forwardToWorkspaceStub(
  c: Parameters<typeof handleExportFromWorker>[0],
  workspaceId: string,
  stub: DurableObjectStub,
  requestOverride?: Request,
): Promise<Response> {
  const source = requestOverride ?? c.req.raw;
  const headers = new Headers(source.headers);
  headers.delete("content-length");
  headers.set("X-Workspace-Id", workspaceId);
  const authClaims = c.get("authClaims");
  if (authClaims?.workspaceId) {
    headers.set("X-Auth-Workspace-Id", authClaims.workspaceId);
  }
  const init: RequestInit = {
    method: source.method,
    headers,
    redirect: "manual",
  };
  if (source.method !== "GET" && source.method !== "HEAD") {
    init.body = await source.clone().arrayBuffer();
  }
  return fetchWorkspaceDOWithBackpressure(stub, new Request(source.url, init), {
    reason: "durable_object_overloaded",
    retryAfterSeconds: c.env.RELAYFILE_DO_RETRY_AFTER_SECONDS
      ? Number.parseInt(c.env.RELAYFILE_DO_RETRY_AFTER_SECONDS, 10)
      : undefined,
  });
}

function mergeBulkWriteAggregate(
  aggregate: BulkWriteAggregate,
  payload: unknown,
): void {
  const body =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  aggregate.written += numberField(body.written);
  aggregate.errorCount += numberField(body.errorCount);
  if (Array.isArray(body.errors)) {
    appendValues(aggregate.errors, body.errors);
  }
  if (
    aggregate.correlationId === undefined &&
    body.correlationId !== undefined
  ) {
    aggregate.correlationId = body.correlationId;
  }
  appendArrayField(aggregate, body, "dedupedFiles");
  addNumberField(aggregate, body, "bytesWritten");
  addNumberField(aggregate, body, "syncCount");
  addNumberField(aggregate, body, "fileCountDelta");
  addNumberField(aggregate, body, "bytesStoredDelta");
  addNumberField(aggregate, body, "operationCountDelta");
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function appendArrayField(
  aggregate: BulkWriteAggregate,
  body: Record<string, unknown>,
  key: "dedupedFiles",
): void {
  const value = body[key];
  if (!Array.isArray(value) || value.length === 0) {
    return;
  }
  const target = aggregate[key] ?? [];
  appendValues(target, value);
  aggregate[key] = target;
}

function addNumberField(
  aggregate: BulkWriteAggregate,
  body: Record<string, unknown>,
  key:
    | "bytesWritten"
    | "syncCount"
    | "fileCountDelta"
    | "bytesStoredDelta"
    | "operationCountDelta",
): void {
  const value = numberField(body[key]);
  if (value !== 0 || aggregate[key] !== undefined) {
    aggregate[key] = (aggregate[key] ?? 0) + value;
  }
}

function appendValues(target: unknown[], values: unknown[]): void {
  for (const value of values) {
    target.push(value);
  }
}

async function handleBulkReadFromWorker(
  c: Parameters<typeof handleExportFromWorker>[0],
  workspaceId: string,
): Promise<Response> {
  const guarded = await readBulkReadBody(c, c.req.raw as unknown as Request);
  if ("response" in guarded) {
    return guarded.response;
  }

  const paths = parseBulkReadPaths(c, guarded.body);
  if ("response" in paths) {
    return paths.response;
  }

  const files: BulkReadFileResult[] = [];
  for (const path of paths.paths) {
    const result = await readFileForBulk(c, workspaceId, path);
    files.push(result);
  }

  emitMetric("relayfile_worker_fs_bulk_read_files_total", files.length, {
    workspace_id: workspaceId,
  });

  return c.json({ files });
}

function parseBulkReadPaths(
  c: AppContext,
  body: BulkReadRequestBody,
): { paths: string[] } | { response: Response } {
  const rawEntries = Array.isArray(body.paths)
    ? body.paths
    : Array.isArray(body.files)
      ? body.files
      : null;
  if (!rawEntries) {
    return {
      response: jsonError(c, 400, "bad_request", "paths must be an array"),
    };
  }
  if (rawEntries.length > MAX_BULK_READ_FILES) {
    return {
      response: jsonError(
        c,
        400,
        "bad_request",
        `paths must include at most ${MAX_BULK_READ_FILES} entries`,
      ),
    };
  }

  const paths = rawEntries
    .map((entry) =>
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object"
          ? (entry as { path?: unknown }).path
          : undefined,
    )
    .filter((path): path is string => typeof path === "string")
    .map(normalizeRoutePath)
    .filter((path) => path !== "/");

  if (paths.length !== rawEntries.length) {
    return {
      response: jsonError(
        c,
        400,
        "bad_request",
        "each bulk-read entry must include a non-empty path",
      ),
    };
  }

  return { paths };
}

async function readFileForBulk(
  c: Parameters<typeof handleExportFromWorker>[0],
  workspaceId: string,
  path: string,
): Promise<BulkReadFileResult> {
  emitWorkerVfsPlaneResolvedMetric(workspaceId, path, "file_read_worker_bulk");
  const metadataResponse = await fetchReadMetadata(c, workspaceId, path);
  if (!metadataResponse.ok) {
    return {
      path,
      error: await responseError(metadataResponse),
    };
  }

  const metadata = (await metadataResponse.json()) as WorkerFileReadMetadata;
  const content = await loadBodyFromR2(c, metadata);
  return metadataToFileReadResponse(metadata, content);
}

async function fetchReadMetadata(
  c: Parameters<typeof handleExportFromWorker>[0],
  workspaceId: string,
  path: string,
): Promise<Response> {
  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  headers.set("X-Workspace-Id", workspaceId);
  const incomingAuth = c.req.raw.headers.get("Authorization");
  if (incomingAuth) headers.set("Authorization", incomingAuth);
  const correlationId = c.req.raw.headers.get("X-Correlation-Id");
  if (correlationId) headers.set("X-Correlation-Id", correlationId);
  const authClaims = c.get("authClaims");
  if (authClaims?.workspaceId) {
    headers.set("X-Auth-Workspace-Id", authClaims.workspaceId);
  }

  const url = new URL(c.req.url);
  url.pathname = "/internal/read-file-metadata";
  url.search = "";

  const { stub } = await getWorkspaceStubForPath(c, workspaceId, path, {
    operation: "file_read_metadata",
  });
  return fetchWorkspaceDOWithBackpressure(
    stub,
    new Request(url.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify({ workspaceId, path }),
    }),
    {
      reason: "durable_object_overloaded",
      retryAfterSeconds: c.env.RELAYFILE_DO_RETRY_AFTER_SECONDS
        ? Number.parseInt(c.env.RELAYFILE_DO_RETRY_AFTER_SECONDS, 10)
        : undefined,
    },
  );
}

async function responseError(
  response: Response,
): Promise<{ status: number; code: string; message: string }> {
  const fallback = {
    status: response.status,
    code: "read_failed",
    message: response.statusText || "file read failed",
  };
  try {
    const body = (await response.clone().json()) as {
      code?: unknown;
      message?: unknown;
    };
    return {
      status: response.status,
      code: typeof body.code === "string" ? body.code : fallback.code,
      message:
        typeof body.message === "string" ? body.message : fallback.message,
    };
  } catch {
    return fallback;
  }
}

function emitWorkerVfsPlaneResolvedMetric(
  workspaceId: string,
  path: unknown,
  operation: string,
): void {
  const route = resolveVfsPlaneRoute(workspaceId, path);
  emitMetric("relayfile_vfs_plane_resolved_total", 1, {
    workspace_id: workspaceId,
    operation,
    ...vfsPlaneLogLabels(route),
  });
}
