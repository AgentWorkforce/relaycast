import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  type MintPathScopedRelayfileTokenOptions,
  mintRelayfileToken,
  mintPathScopedRelayfileToken,
  mintScopedRelayfileToken,
  mintWorkspaceApiKey,
} from "@cloud/core/relayfile/client.js";
import {
  type WorkspacePermissions,
} from "@cloud/core/workspace/registry.js";
import {
  generateWorkspaceId,
  isValidWorkspaceId,
} from "@cloud/core/workspace/id.js";
import { getDb } from "@/lib/db";
import { relayWorkspaces } from "@/lib/db/schema";
import { resolveRelayAuthConfig, resolveRelayfileConfig } from "@/lib/relayfile";

export { generateWorkspaceId, isValidWorkspaceId };

export type RelayWorkspaceRecord = {
  id: string;
  ownerUserId: string;
  name: string;
  relaycastApiKey: string;
  permissions: WorkspacePermissions;
  createdAt: Date;
  updatedAt: Date;
};

type NormalizedScope = {
  raw: string;
  action: "read" | "write";
  path: string;
};

type NormalizedPattern = {
  scopePath: string;
};

type RelayfileReadResponse = {
  revision: string;
  content: string;
  contentType?: string;
  encoding?: string;
  semantics?: {
    properties?: Record<string, string>;
    relations?: string[];
    permissions?: string[];
    comments?: string[];
  };
};

type CompiledJoinAccess = {
  publicScopes: string[];
  aclPermissions: string[];
  // Daemon-vocabulary scopes (bare `fs:read`, ACL `workspace:<agent>:…`) for
  // the legacy `/v1/tokens` mint, which stores scopes verbatim. The relayfile
  // daemon's `scopeMatches` understands these.
  tokenScopes: string[];
  // 4-segment RelayAuth-vocabulary scopes (`relayfile:fs:read:*`,
  // `relayfile:sync:trigger:*`, …) for the strict `/v1/tokens/{workspace,
  // agent}` delegated mint chain, which rejects bare/`workspace:`-plane
  // scopes. The daemon's `scopeMatches` translates these 4-segment scopes to
  // satisfy its bare requirements, so the issued token still authorizes the
  // daemon. Per-path denies live in the durable ACL marker as
  // `relayfile:fs:<action>:<path>` rules and are matched semantically against
  // these grants by the daemon.
  relayAuthTokenScopes: string[];
  // True when the workspace has per-path ignored/readonly overrides that
  // produce broad-grant-plus-deny semantics. Kept as a diagnostic bit for
  // callers/tests; delegated-token minting is safe because deny rules are
  // emitted in relayfile 4-segment form and evaluated semantically.
  hasDenyOverrides: boolean;
};

const DEFAULT_REQUESTED_SCOPES = ["relayfile:fs:read:*", "relayfile:fs:write:*"];
const WORKSPACE_TOKEN_SCOPES = [
  "relayauth:token:create:*",
  ...DEFAULT_REQUESTED_SCOPES,
];
const ADMIN_AGENT_NAME = "cloud-workspace-admin";
const DEFAULT_WORKSPACE_AGENT_NAME = "workspace-default";
const ROOT_ACL_FILE = "/.relayfile.acl";
const ROOT_ACL_CONTENT = "# Managed by workspace API\n";
const ROOT_ACL_CONTENT_TYPE = "text/plain; charset=utf-8";
const ROOT_ACL_ENCODING = "utf-8";
const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RELAYFILE_REQUEST_TIMEOUT_MS = 15_000;

// Names reserved for internal trust-bearing minters. Any agent the cloud
// uses to short-circuit per-request gates (writeback queueing, auth bypass,
// etc.) MUST live here so the same name can't be obtained by an external
// caller through /join or /provision and impersonate the internal flow.
//
// Keep in sync with `PROVIDER_SYNC_AGENT_NAMES` in
// `packages/relayfile/src/middleware/auth.ts`.
const RESERVED_AGENT_NAMES: ReadonlySet<string> = new Set([
  "cloud-github",
  "github-clone-worker",
  "nango-sync-worker",
  "nango-sync-workflow",
]);
const GLOB_PATTERN = /[*?\[]/;
const workspaceApiKeyCache = new Map<string, Promise<string>>();

type RelayAuthWorkspaceTokenCacheKey = {
  relayAuthApiKey: string;
  workspaceId: string;
};

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function workspaceTokenCacheKey(input: RelayAuthWorkspaceTokenCacheKey): string {
  const apiKeyHash = crypto.createHash("sha256").update(input.relayAuthApiKey).digest("hex");
  return `${input.workspaceId}:${apiKeyHash}`;
}

export function evictRelayAuthWorkspaceTokenCache(input: RelayAuthWorkspaceTokenCacheKey): void {
  workspaceApiKeyCache.delete(workspaceTokenCacheKey(input));
}

export function isRelayAuthPathTokenUnauthorizedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /\brelayauth path-token mint failed:\s*401\b/i.test(error.message)
    || /\bRelayAuth request failed \(401\)\s+\/v1\/tokens\/path\b/i.test(error.message);
}

function normalizeStringList(values: readonly string[] | undefined): string[] {
  return unique((values ?? []).map((value) => value.trim()).filter(Boolean));
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }

  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readNumericClaim(
  claims: Record<string, unknown> | null,
  key: string,
): number | null {
  const value = claims?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toIsoTimestamp(value: number | null): string | null {
  return value === null ? null : new Date(value * 1000).toISOString();
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizePath(input: string): string {
  const trimmed = input.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed === "/") {
    return "/";
  }

  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const collapsed = withLeadingSlash.replace(/\/+/g, "/");
  return collapsed.length > 1 && collapsed.endsWith("/")
    ? collapsed.slice(0, -1)
    : collapsed;
}

function normalizeScopePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed || trimmed === "*") {
    return "*";
  }

  if (trimmed.endsWith("/*")) {
    const base = normalizePath(trimmed.slice(0, -2));
    return base === "/" ? "*" : `${base}/*`;
  }

  if (trimmed.endsWith("/")) {
    const base = normalizePath(trimmed);
    return base === "/" ? "*" : `${base}/*`;
  }

  return normalizePath(trimmed);
}

function normalizePattern(input: string): NormalizedPattern | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  if (
    trimmed === "*" ||
    trimmed === "**" ||
    trimmed === "/*" ||
    trimmed === "/**" ||
    trimmed === "**/*"
  ) {
    return { scopePath: "*" };
  }

  if (trimmed.endsWith("/")) {
    const directory = normalizePath(trimmed.slice(0, -1));
    return {
      scopePath: directory === "/" ? "*" : `${directory}/*`,
    };
  }

  if (GLOB_PATTERN.test(trimmed)) {
    const firstGlob = trimmed.search(GLOB_PATTERN);
    const staticPrefix = firstGlob >= 0 ? trimmed.slice(0, firstGlob) : trimmed;
    if (!staticPrefix) {
      return { scopePath: "*" };
    }

    const prefixIsDirectory = staticPrefix.endsWith("/");
    const normalizedPrefix = normalizePath(
      prefixIsDirectory ? staticPrefix.slice(0, -1) : staticPrefix,
    );
    const directoryPath = prefixIsDirectory
      ? normalizedPrefix
      : normalizedPrefix.includes("/")
        ? normalizePath(normalizedPrefix.split("/").slice(0, -1).join("/"))
        : "/";

    return {
      scopePath: directoryPath === "/" ? "*" : `${directoryPath}/*`,
    };
  }

  return {
    scopePath: normalizePath(trimmed),
  };
}

function normalizeRequestedScope(raw: string): NormalizedScope | null {
  const parts = raw.split(":");
  if (parts.length < 3 || parts.length > 4) {
    return null;
  }

  const [plane, resource, actionRaw, pathRaw] = parts;
  const action = actionRaw?.trim().toLowerCase();
  if (plane !== "relayfile" || resource !== "fs" || (action !== "read" && action !== "write")) {
    return null;
  }

  const path = normalizeScopePath(pathRaw ?? "*");
  return {
    raw: `relayfile:fs:${action}:${path}`,
    action,
    path,
  };
}

function normalizePatterns(input: readonly string[]): NormalizedPattern[] {
  const patterns: NormalizedPattern[] = [];
  for (const entry of input) {
    const normalized = normalizePattern(entry);
    if (normalized) {
      patterns.push(normalized);
    }
  }
  return patterns;
}

function pathCoversScope(scopePath: string, targetPath: string): boolean {
  if (scopePath === "*") {
    return true;
  }

  if (targetPath === "*") {
    return scopePath === "*";
  }

  const scopeWildcardBase = scopeWildcardDirectoryBase(scopePath);
  if (scopeWildcardBase !== null) {
    return targetPath === scopeWildcardBase || targetPath.startsWith(`${scopeWildcardBase}/`);
  }

  if (scopeWildcardDirectoryBase(targetPath) !== null) {
    return false;
  }

  return scopePath === targetPath;
}

function scopeWildcardDirectoryBase(scopePath: string): string | null {
  if (scopePath.endsWith("/**")) {
    const base = scopePath.slice(0, -"/**".length);
    return base ? normalizePath(base) : "";
  }
  if (scopePath.endsWith("/*")) {
    const base = scopePath.slice(0, -"/*".length);
    return base ? normalizePath(base) : "";
  }
  return null;
}

function scopeIntersectsPath(scopePath: string, targetPath: string): boolean {
  return pathCoversScope(scopePath, targetPath) || pathCoversScope(targetPath, scopePath);
}

function filterEffectiveScopes(
  scopes: NormalizedScope[],
  ignored: NormalizedPattern[],
  readonly: NormalizedPattern[],
): NormalizedScope[] {
  return scopes.filter((scope) => {
    if (ignored.some((pattern) => pathCoversScope(pattern.scopePath, scope.path))) {
      return false;
    }

    if (
      scope.action === "write" &&
      readonly.some((pattern) => pathCoversScope(pattern.scopePath, scope.path))
    ) {
      return false;
    }

    return true;
  });
}

function collectOverrideTargets(
  ignored: NormalizedPattern[],
  readonly: NormalizedPattern[],
): string[] {
  return unique([
    ...ignored.map((pattern) => pattern.scopePath),
    ...readonly.map((pattern) => pattern.scopePath),
  ]);
}

function buildWorkspaceAclScope(agentName: string, action: "read" | "write", path: string): string {
  return `workspace:${agentName}:${action}:${path}`;
}

function buildRelayfileAclScope(action: "read" | "write", path: string): string {
  return `relayfile:fs:${action}:${path}`;
}

function parsePermissionsJson(raw: string): WorkspacePermissions {
  try {
    const parsed = JSON.parse(raw) as Partial<WorkspacePermissions>;
    return normalizeWorkspacePermissions(parsed);
  } catch {
    return { ignored: [], readonly: [] };
  }
}

function mapRelayWorkspace(record: typeof relayWorkspaces.$inferSelect): RelayWorkspaceRecord {
  return {
    id: record.id,
    ownerUserId: record.ownerUserId,
    name: record.name,
    relaycastApiKey: record.relaycastApiKey,
    permissions: parsePermissionsJson(record.permissionsJson),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function compileJoinAccess(
  agentName: string,
  requestedScopes: readonly string[] | undefined,
  permissions: WorkspacePermissions,
): CompiledJoinAccess {
  let normalizedRequestedScopes = [
    ...new Map(
      (requestedScopes && requestedScopes.length > 0 ? requestedScopes : DEFAULT_REQUESTED_SCOPES)
        .map((scope) => normalizeRequestedScope(scope))
        .filter((scope): scope is NormalizedScope => scope !== null)
        .map((scope) => [scope.raw, scope]),
    ).values(),
  ];

  // Fall back to defaults if all requested scopes were non-relayfile and got filtered out
  if (normalizedRequestedScopes.length === 0) {
    normalizedRequestedScopes = [
      ...new Map(
        DEFAULT_REQUESTED_SCOPES
          .map((scope) => normalizeRequestedScope(scope))
          .filter((scope): scope is NormalizedScope => scope !== null)
          .map((scope) => [scope.raw, scope]),
      ).values(),
    ];
  }

  const ignoredPatterns = normalizePatterns(permissions.ignored);
  const readonlyPatterns = normalizePatterns(permissions.readonly);
  const effectiveScopes = filterEffectiveScopes(
    normalizedRequestedScopes,
    ignoredPatterns,
    readonlyPatterns,
  );

  const allowScopes = new Set<string>();
  const denyScopes = new Set<string>();

  for (const scope of effectiveScopes) {
    allowScopes.add(buildWorkspaceAclScope(agentName, scope.action, scope.path));
  }

  for (const targetPath of collectOverrideTargets(ignoredPatterns, readonlyPatterns)) {
    for (const scope of effectiveScopes) {
      if (!scopeIntersectsPath(scope.path, targetPath)) {
        continue;
      }

      const denyIgnored = ignoredPatterns.some((pattern) => pathCoversScope(pattern.scopePath, targetPath));
      const denyWrite =
        scope.action === "write" &&
        readonlyPatterns.some((pattern) => pathCoversScope(pattern.scopePath, targetPath));

      if (!denyIgnored && !denyWrite) {
        continue;
      }

      denyScopes.add(buildRelayfileAclScope(scope.action, targetPath));
    }
  }

  const tokenScopes = new Set<string>();
  const hasRead = effectiveScopes.some((scope) => scope.action === "read");
  const hasWrite = effectiveScopes.some((scope) => scope.action === "write");

  if (hasRead) {
    tokenScopes.add("fs:read");
    tokenScopes.add("sync:read");
  }
  if (hasWrite) {
    tokenScopes.add("fs:write");
  }
  // Introspection scopes — granted whenever the agent has any real
  // access. ops:read enables `relayfile ops list` / GET /ops/{opId}
  // for diagnosing failed writebacks; sync:trigger enables
  // `relayfile pull` to force a refresh. Without these, agents have
  // no documented way to see whether a write actually landed at the
  // source provider — the original gap that motivated the
  // writeback-reliability spec phase 3.
  if (hasRead || hasWrite) {
    tokenScopes.add("ops:read");
    tokenScopes.add("sync:trigger");
  }

  for (const scope of allowScopes) {
    tokenScopes.add(scope);
  }

  if (tokenScopes.size === 0) {
    tokenScopes.add(buildWorkspaceAclScope(agentName, "read", "/__denied__/*"));
  }

  // 4-segment RelayAuth-vocabulary scopes for the strict delegated mint chain.
  // Positive path-scoped grants only (effectiveScopes already excludes
  // fully-ignored and readonly-covered paths); the relayfile daemon's
  // `scopeMatches` translates these to satisfy its bare `fs:read`/`fs:write`
  // path requirements. Capability scopes mirror the daemon-vocab block above
  // (`sync:read`, `sync:trigger`, `ops:read`) in `relayfile:` plane form.
  const relayAuthTokenScopes = new Set<string>();
  for (const scope of effectiveScopes) {
    relayAuthTokenScopes.add(scope.raw);
  }
  if (hasRead) {
    relayAuthTokenScopes.add("relayfile:sync:read:*");
  }
  if (hasRead || hasWrite) {
    relayAuthTokenScopes.add("relayfile:sync:trigger:*");
    relayAuthTokenScopes.add("relayfile:ops:read:*");
  }

  return {
    publicScopes: effectiveScopes.map((scope) => scope.raw),
    aclPermissions: unique([
      ...[...allowScopes].map((scope) => `allow:scope:${scope}`),
      ...[...denyScopes].map((scope) => `deny:scope:${scope}`),
    ]),
    tokenScopes: unique(tokenScopes),
    relayAuthTokenScopes: unique(relayAuthTokenScopes),
    hasDenyOverrides: denyScopes.size > 0,
  };
}

async function relayfileRequest<T>(
  relayfileUrl: string,
  token: string,
  workspaceId: string,
  init: {
    method: "GET" | "PUT";
    path: string;
    correlationId: string;
    ifMatch?: string;
    body?: unknown;
  },
): Promise<{ ok: true; status: number; data: T } | { ok: false; status: number; text: string }> {
  const url = new URL(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/fs/file`,
    `${stripTrailingSlash(relayfileUrl)}/`,
  );
  url.searchParams.set("path", init.path);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RELAYFILE_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await globalThis.fetch(url, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Correlation-Id": init.correlationId,
        ...(init.ifMatch ? { "If-Match": init.ifMatch } : {}),
      },
      signal: controller.signal,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `relayfile ACL ${init.method} ${init.path} timed out after ${RELAYFILE_REQUEST_TIMEOUT_MS}ms`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    return { ok: false, status: response.status, text: await response.text() };
  }

  return {
    ok: true,
    status: response.status,
    data: (await response.json()) as T,
  };
}

export function isValidAgentName(value: string): boolean {
  const trimmed = value.trim();
  if (!AGENT_NAME_PATTERN.test(trimmed)) {
    return false;
  }
  // Reject names reserved for internal trust-bearing minters so external
  // callers can't mint a token whose claims would short-circuit
  // server-side gates (e.g. `isProviderSyncWriter` in
  // packages/relayfile/src/middleware/auth.ts).
  if (RESERVED_AGENT_NAMES.has(trimmed)) {
    return false;
  }
  return true;
}

// Scope format: colon-separated segments (e.g. "relayfile:fs:read:*", "relayauth:*:manage:*")
const SCOPE_FORMAT = /^[a-z][a-z0-9_*-]*(?::[a-z0-9_*./-]+)*$/i;

export function areValidRequestedScopes(scopes: unknown): scopes is string[] {
  if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every((s) => typeof s === "string")) {
    return false;
  }
  // Validate format but don't restrict to relayfile-only scopes.
  // The relay CLI sends relayfile, relayauth, and fs scopes.
  // compileJoinAccess filters to relayfile scopes during compilation;
  // non-relayfile scopes are silently dropped, not rejected here.
  return scopes.every((scope: string) => SCOPE_FORMAT.test(scope.trim()));
}

export function normalizeWorkspacePermissions(
  input?: Partial<{ ignored?: string[]; readonly?: string[] }>,
): WorkspacePermissions {
  return {
    ignored: normalizeStringList(input?.ignored),
    readonly: normalizeStringList(input?.readonly),
  };
}

export function hasPermissionOverrides(permissions: WorkspacePermissions): boolean {
  return permissions.ignored.length > 0 || permissions.readonly.length > 0;
}

export function mergeWorkspacePermissions(
  base: WorkspacePermissions,
  override?: Partial<{ ignored?: string[]; readonly?: string[] }>,
): WorkspacePermissions {
  const normalizedOverride = normalizeWorkspacePermissions(override);
  return {
    ignored: unique([...base.ignored, ...normalizedOverride.ignored]),
    readonly: unique([...base.readonly, ...normalizedOverride.readonly]),
  };
}

export async function createRelayWorkspaceRecord(input: {
  id: string;
  ownerUserId: string;
  name: string;
  relaycastApiKey: string;
  permissions: WorkspacePermissions;
}): Promise<RelayWorkspaceRecord> {
  const db = getDb();
  const timestamp = new Date();
  const [record] = await db
    .insert(relayWorkspaces)
    .values({
      id: input.id,
      ownerUserId: input.ownerUserId,
      name: input.name,
      relaycastApiKey: input.relaycastApiKey,
      permissionsJson: JSON.stringify(input.permissions),
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .returning();

  return mapRelayWorkspace(record);
}

export async function getRelayWorkspace(
  workspaceId: string,
): Promise<RelayWorkspaceRecord | null> {
  const db = getDb();
  const [record] = await db
    .select()
    .from(relayWorkspaces)
    .where(eq(relayWorkspaces.id, workspaceId))
    .limit(1);

  return record ? mapRelayWorkspace(record) : null;
}

export async function getRelayWorkspaceByRelaycastApiKey(
  relaycastApiKey: string,
): Promise<RelayWorkspaceRecord | null> {
  const normalized = relaycastApiKey.trim();
  if (!normalized) {
    return null;
  }

  const db = getDb();
  const [record] = await db
    .select()
    .from(relayWorkspaces)
    .where(eq(relayWorkspaces.relaycastApiKey, normalized))
    .limit(1);

  return record ? mapRelayWorkspace(record) : null;
}

export async function updateRelayWorkspaceRelaycastApiKey(
  workspaceId: string,
  relaycastApiKey: string,
): Promise<RelayWorkspaceRecord | null> {
  const normalized = relaycastApiKey.trim();
  if (!normalized) {
    throw new Error("relaycastApiKey is required");
  }

  const db = getDb();
  const [record] = await db
    .update(relayWorkspaces)
    .set({ relaycastApiKey: normalized, updatedAt: new Date() })
    .where(eq(relayWorkspaces.id, workspaceId))
    .returning();

  return record ? mapRelayWorkspace(record) : null;
}

export async function getOwnedRelayWorkspace(
  workspaceId: string,
  ownerUserId: string,
): Promise<RelayWorkspaceRecord | null> {
  const db = getDb();
  const [record] = await db
    .select()
    .from(relayWorkspaces)
    .where(and(eq(relayWorkspaces.id, workspaceId), eq(relayWorkspaces.ownerUserId, ownerUserId)))
    .limit(1);

  return record ? mapRelayWorkspace(record) : null;
}

/**
 * HARD-DELETE a workspace's relayfile state (DO SQLite storage + R2 object
 * bodies + D1 metadata) by calling the relayfile control-plane endpoint
 * `DELETE /v1/workspaces/{workspaceId}`.
 *
 * Soft-vs-hard decision: HARD delete. The explicit product goal is to
 * remove orphaned workspaces so they stop accruing DO/R2 storage cost; a
 * tombstone that kept the expensive bytes around would not solve the
 * problem. relay_workspaces has no audit/retention requirement (it is a
 * pure cloud-mount registry row), so there is no reason to keep a
 * tombstone here.
 *
 * Best-effort + idempotent: the relayfile endpoint returns 200 with zeroed
 * counts for an already-purged workspace, so a retried cloud delete still
 * succeeds. Mints a short-lived (120s) `admin:workspace`-scoped token
 * (server-side trust, never exposed to agents) for the call.
 *
 * @param workspaceId - The relay workspace id to purge.
 * @returns `{ ok, status, deletedObjects }` on success.
 * @throws If relayfile is unavailable or the purge call returns non-2xx.
 */
export async function purgeRelayfileWorkspace(workspaceId: string): Promise<{
  ok: boolean;
  status: number;
  deletedObjects: number;
}> {
  const { relayfileUrl, relayAuthUrl, relayAuthApiKey } = resolveRelayfileConfig();
  if (!relayfileUrl || !relayAuthApiKey) {
    throw new Error("Relayfile unavailable");
  }

  const adminToken = await mintRelayfileToken({
    workspaceId,
    relayAuthUrl,
    relayAuthApiKey,
    agentName: ADMIN_AGENT_NAME,
    scopes: ["admin:workspace"],
    ttlSeconds: 120,
  });

  const url = new URL(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}`,
    `${stripTrailingSlash(relayfileUrl)}/`,
  );

  const response = await globalThis.fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "X-Correlation-Id": crypto.randomUUID(),
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `relayfile workspace purge failed with status ${response.status}: ${text.slice(0, 500)}`,
    );
  }

  const body = (await response.json().catch(() => ({}))) as {
    deletedObjects?: unknown;
  };
  const deletedObjects =
    typeof body.deletedObjects === "number" ? body.deletedObjects : 0;

  return { ok: true, status: response.status, deletedObjects };
}

/**
 * Delete the relay_workspaces registry row for a workspace.
 *
 * @param workspaceId - The relay workspace id whose registry row to remove.
 * @returns `true` if a row was actually removed; `false` if it was already
 *   gone (lets the caller distinguish a 404 from a successful cascade).
 */
export async function deleteRelayWorkspaceRecord(
  workspaceId: string,
): Promise<boolean> {
  const db = getDb();
  const deleted = await db
    .delete(relayWorkspaces)
    .where(eq(relayWorkspaces.id, workspaceId))
    .returning({ id: relayWorkspaces.id });
  return deleted.length > 0;
}

export function toRelayfileWebSocketUrl(relayfileUrl: string, workspaceId: string): string {
  const url = new URL(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/fs/ws`,
    `${stripTrailingSlash(relayfileUrl)}/`,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export async function ensureRelayWorkspace(workspaceId: string, permissions: WorkspacePermissions): Promise<void> {
  const { relayfileUrl, relayAuthUrl, relayAuthApiKey } = resolveRelayfileConfig();
  if (!relayfileUrl || !relayAuthApiKey) {
    throw new Error("Relayfile unavailable");
  }

  const seededPermissions = hasPermissionOverrides(permissions)
    ? compileJoinAccess(DEFAULT_WORKSPACE_AGENT_NAME, DEFAULT_REQUESTED_SCOPES, permissions).aclPermissions
    : [];

  await upsertRelayWorkspaceAcl(workspaceId, relayfileUrl, relayAuthUrl, relayAuthApiKey, seededPermissions);
}

export async function ensureRelayWorkspaceAclPermissions(
  workspaceId: string,
  aclPermissions: readonly string[],
): Promise<void> {
  if (aclPermissions.length === 0) {
    return;
  }
  const { relayfileUrl, relayAuthUrl, relayAuthApiKey } = resolveRelayfileConfig();
  if (!relayfileUrl || !relayAuthApiKey) {
    throw new Error("Relayfile unavailable");
  }

  await upsertRelayWorkspaceAcl(workspaceId, relayfileUrl, relayAuthUrl, relayAuthApiKey, aclPermissions);
}

export async function createWorkspaceJoinAccess(input: {
  workspaceId: string;
  agentName: string;
  requestedScopes?: string[];
  permissions: WorkspacePermissions;
}): Promise<{
  token: string;
  tokenIssuedAt: string | null;
  tokenExpiresAt: string | null;
  suggestedRefreshAt: string | null;
  relayfileUrl: string;
  wsUrl: string;
  scopes: string[];
  tokenScopes: string[];
  relayAuthTokenScopes: string[];
  hasDenyOverrides: boolean;
}> {
  const { relayfileUrl, relayAuthUrl, relayAuthApiKey } = resolveRelayfileConfig();
  if (!relayfileUrl || !relayAuthApiKey) {
    throw new Error("Relayfile unavailable");
  }

  const compiled = compileJoinAccess(input.agentName, input.requestedScopes, input.permissions);
  // Default joins need only a token; permission overrides are the cases that
  // require durable ACL denies on Relayfile's root marker.
  if (hasPermissionOverrides(input.permissions)) {
    await upsertRelayWorkspaceAcl(
      input.workspaceId,
      relayfileUrl,
      relayAuthUrl,
      relayAuthApiKey,
      compiled.aclPermissions,
    );
  }

  const token = await mintScopedRelayfileToken({
    workspaceId: input.workspaceId,
    agentName: input.agentName,
    scopes: compiled.tokenScopes,
    relayAuthUrl,
    relayAuthApiKey,
  });
  const tokenClaims = decodeJwtPayload(token);
  const issuedAtSeconds = readNumericClaim(tokenClaims, "iat");
  const expiresAtSeconds = readNumericClaim(tokenClaims, "exp");
  const refreshAtSeconds =
    issuedAtSeconds !== null && expiresAtSeconds !== null
      ? Math.max(
          issuedAtSeconds,
          expiresAtSeconds - Math.max(300, Math.floor((expiresAtSeconds - issuedAtSeconds) * 0.1)),
        )
      : null;

  return {
    token,
    tokenIssuedAt: toIsoTimestamp(issuedAtSeconds),
    tokenExpiresAt: toIsoTimestamp(expiresAtSeconds),
    suggestedRefreshAt: toIsoTimestamp(refreshAtSeconds),
    relayfileUrl: stripTrailingSlash(relayfileUrl),
    wsUrl: toRelayfileWebSocketUrl(relayfileUrl, input.workspaceId),
    scopes: compiled.publicScopes,
    tokenScopes: compiled.tokenScopes,
    relayAuthTokenScopes: compiled.relayAuthTokenScopes,
    hasDenyOverrides: compiled.hasDenyOverrides,
  };
}

/**
 * Mint a RelayAuth workspace API key (`relay_ws_*`) that path-scoped
 * Relayfile tokens can be derived from. The org-level `RELAYAUTH_API_KEY`
 * isn't itself a workspace token, so `/v1/tokens/path` rejects it — we
 * exchange it for a workspace key via `/v1/tokens/workspace` first.
 *
 * Cached per `(workspaceId, sha256(orgApiKey))` so repeated box warms don't
 * re-mint. Failed mints evict the cache so transient errors don't pin a
 * rejected promise.
 */
export async function mintRelayAuthWorkspaceToken(input: {
  workspaceId: string;
  agentName: string;
}): Promise<string> {
  const { relayAuthUrl, relayAuthApiKey } = resolveRelayAuthConfig();
  if (!relayAuthApiKey) {
    throw new Error("RelayAuth unavailable");
  }

  const cacheKey = workspaceTokenCacheKey({ relayAuthApiKey, workspaceId: input.workspaceId });
  const cached = workspaceApiKeyCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const promise = mintWorkspaceApiKey({
    workspaceId: input.workspaceId,
    relayAuthUrl,
    relayAuthApiKey,
    scopes: WORKSPACE_TOKEN_SCOPES,
    name: `cloud-agent-box:${input.workspaceId}`,
  }).catch((error) => {
    workspaceApiKeyCache.delete(cacheKey);
    throw error;
  });
  workspaceApiKeyCache.set(cacheKey, promise);
  return promise;
}

export async function mintPathScopedRelayfileTokenWithWorkspaceCache(input: Omit<
  MintPathScopedRelayfileTokenOptions,
  "workspaceToken" | "relayAuthApiKey"
>): Promise<string> {
  const { relayAuthApiKey } = resolveRelayAuthConfig();
  const agentName = input.agentName?.trim() || "cloud-orchestrator";
  const workspaceToken = await mintRelayAuthWorkspaceToken({
    workspaceId: input.workspaceId,
    agentName,
  });

  try {
    return await mintPathScopedRelayfileToken({
      ...input,
      workspaceToken,
    });
  } catch (error) {
    if (!relayAuthApiKey || !isRelayAuthPathTokenUnauthorizedError(error)) {
      throw error;
    }

    evictRelayAuthWorkspaceTokenCache({
      relayAuthApiKey,
      workspaceId: input.workspaceId,
    });
    const freshWorkspaceToken = await mintRelayAuthWorkspaceToken({
      workspaceId: input.workspaceId,
      agentName,
    });
    return mintPathScopedRelayfileToken({
      ...input,
      workspaceToken: freshWorkspaceToken,
    });
  }
}

async function upsertRelayWorkspaceAcl(
  workspaceId: string,
  relayfileUrl: string,
  relayAuthUrl: string,
  relayAuthApiKey: string,
  aclPermissions: readonly string[],
): Promise<void> {
  const adminToken = await mintRelayfileToken({
    workspaceId,
    relayAuthUrl,
    relayAuthApiKey,
    agentName: ADMIN_AGENT_NAME,
    scopes: ["fs:read", "fs:write", "sync:read", "sync:trigger", "admin:acl"],
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const correlationId = crypto.randomUUID();
    const existing = await relayfileRequest<RelayfileReadResponse>(
      relayfileUrl,
      adminToken,
      workspaceId,
      {
        method: "GET",
        path: ROOT_ACL_FILE,
        correlationId,
      },
    );

    if (!existing.ok && existing.status !== 404) {
      throw new Error(
        `relayfile ACL read failed with status ${existing.status}: ${existing.text}`,
      );
    }

    const current = existing.ok ? existing.data : null;
    // Grant the baseline read/write scopes on the root ACL so any token
    // carrying `fs:read` / `fs:write` (orchestrator, mount daemon, per-step
    // agents) can operate. `filePermissionAllows` denies by default when ANY
    // rule parses, so an ACL that contained only `allow:agent:<admin>` locked
    // out every other caller by construction. DENY overrides added via
    // `aclPermissions` from `compileJoinAccess` still apply on top of these
    // allows, so per-path readonly/ignored overrides remain effective.
    const permissions = unique([
      `allow:agent:${ADMIN_AGENT_NAME}`,
      "allow:scope:fs:read",
      "allow:scope:fs:write",
      ...(current?.semantics?.permissions ?? []),
      ...aclPermissions,
    ]);

    const write = await relayfileRequest<RelayfileReadResponse>(
      relayfileUrl,
      adminToken,
      workspaceId,
      {
        method: "PUT",
        path: ROOT_ACL_FILE,
        correlationId,
        ifMatch: current?.revision ?? "0",
        body: {
          content: current?.content ?? ROOT_ACL_CONTENT,
          contentType: current?.contentType ?? ROOT_ACL_CONTENT_TYPE,
          encoding: current?.encoding ?? ROOT_ACL_ENCODING,
          semantics: {
            ...(current?.semantics ?? {}),
            permissions,
          },
        },
      },
    );

    if (write.ok) {
      return;
    }

    if (write.status !== 409) {
      throw new Error(
        `relayfile ACL seed failed with status ${write.status}: ${write.text}`,
      );
    }
  }

  throw new Error("relayfile ACL update conflicted repeatedly");
}
