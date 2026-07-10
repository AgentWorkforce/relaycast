import type { RequestAuth } from "@/lib/auth/request-auth";
import {
  normalizeRelayfilePath,
  resilienceScopedRelayfileMountPaths,
} from "@cloud/core/relayfile/path-scopes.js";

export const DEFAULT_MOUNT_AGENT_NAME = "relayfile-mount";
export const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export type MountSessionMode = "poll" | "fuse";

export type MountSessionRequestBody = {
  localDir: string;
  remotePath?: string;
  mode?: MountSessionMode;
  agentName?: string;
  scopes?: string[];
  provider?: string;
};

export type ValidatedMountSessionBody = {
  localDir: string;
  remotePath: string;
  mode: MountSessionMode;
  agentName: string;
  scopes?: string[];
  provider?: string;
};

type ValidationErrorCode =
  | "invalid_request"
  | "invalid_mode"
  | "invalid_local_dir"
  | "invalid_remote_path";

type ScopeAction = "read" | "write";

type NormalizedRelayfileScope = {
  action: ScopeAction;
  path: string;
};

const RELAYFILE_FS_SCOPE = /^relayfile:fs:(read|write):(.+)$/i;

function normalizePathForMatch(input: string): string | null {
  const trimmed = input.trim().replace(/\\/g, "/");
  if (!trimmed) {
    return null;
  }

  if (trimmed === "*" || trimmed === "/*") {
    return "*";
  }

  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const collapsed = withLeadingSlash.replace(/\/+/g, "/");
  if (collapsed.includes("\0")) {
    return null;
  }

  const segments = collapsed.split("/");
  if (segments.some((segment) => segment === "..")) {
    return null;
  }

  if (collapsed.endsWith("/*")) {
    const base = collapsed.slice(0, -2);
    if (!base || base === "/") {
      return "*";
    }
    return `${base}/*`;
  }

  if (collapsed.length > 1 && collapsed.endsWith("/")) {
    const base = collapsed.slice(0, -1);
    return base === "/" ? "*" : `${base}/*`;
  }

  return collapsed;
}

function pathGrantCovers(grantedPath: string, requestedPath: string): boolean {
  if (grantedPath === "*") {
    return true;
  }

  if (requestedPath === "*") {
    return grantedPath === "*";
  }

  if (grantedPath.endsWith("/*")) {
    const prefix = grantedPath.slice(0, -1);
    return requestedPath === grantedPath.slice(0, -2) || requestedPath.startsWith(prefix);
  }

  return grantedPath === requestedPath;
}

function normalizeRequestedRelayfileScope(raw: string): NormalizedRelayfileScope | null {
  const parts = raw.split(":");
  if (parts.length < 4) {
    return null;
  }

  const [plane, resource, actionRaw, ...pathParts] = parts;
  const action = actionRaw?.trim().toLowerCase();
  if (
    plane !== "relayfile" ||
    resource !== "fs" ||
    (action !== "read" && action !== "write")
  ) {
    return null;
  }

  const normalizedPath = normalizePathForMatch(pathParts.join(":") || "*");
  if (!normalizedPath) {
    return null;
  }

  return {
    action,
    path: normalizedPath,
  };
}

function normalizeGrantedRelayfileScope(raw: string): NormalizedRelayfileScope | null {
  if (raw === "fs:read") {
    return { action: "read", path: "*" };
  }

  if (raw === "fs:write") {
    return { action: "write", path: "*" };
  }

  if (raw.startsWith("relayfile:fs:")) {
    return normalizeRequestedRelayfileScope(raw);
  }

  if (!raw.startsWith("workspace:")) {
    return null;
  }

  const parts = raw.split(":");
  if (parts.length < 4) {
    return null;
  }

  const [, , actionRaw, ...pathParts] = parts;
  const action = actionRaw?.trim().toLowerCase();
  if (action !== "read" && action !== "write") {
    return null;
  }

  const normalizedPath = normalizePathForMatch(pathParts.join(":"));
  if (!normalizedPath) {
    return null;
  }

  return {
    action,
    path: normalizedPath,
  };
}

function readScopeGrants(auth: RequestAuth): NormalizedRelayfileScope[] {
  return (auth.scopes ?? [])
    .map((scope) => normalizeGrantedRelayfileScope(scope))
    .filter((scope): scope is NormalizedRelayfileScope => scope !== null);
}

function isDangerousLocalDir(trimmed: string): boolean {
  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (normalized === "/" || normalized === "~" || normalized.startsWith("~/")) {
    return true;
  }

  if (/^[A-Za-z]:(?:[\\/]|$)/.test(trimmed)) {
    return true;
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) {
    return true;
  }

  const exactBlocked = new Set(["/proc", "/sys", "/dev", "/etc/relayfile"]);
  if (exactBlocked.has(normalized)) {
    return true;
  }

  const blockedPrefixes = ["/proc/", "/sys/", "/dev/", "/etc/relayfile/"];
  if (blockedPrefixes.some((prefix) => normalized.startsWith(prefix))) {
    return true;
  }

  const cloudHome = process.env.HOME?.trim();
  if (cloudHome) {
    const normalizedHome = cloudHome.replace(/\\/g, "/").replace(/\/+/g, "/");
    if (
      normalized === normalizedHome ||
      normalized.startsWith(`${normalizedHome}/`)
    ) {
      return true;
    }
  }

  return false;
}

export function validateMountLocalDir(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 1024 || trimmed.includes("\0")) {
    return null;
  }

  if (isDangerousLocalDir(trimmed)) {
    return null;
  }

  return value;
}

export function normalizeMountRemotePath(value: unknown): string | null {
  if (value === undefined || value === null) {
    return "/";
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return "/";
  }

  if (trimmed.includes("\0")) {
    return null;
  }

  const withLeadingSlash = trimmed.replace(/\\/g, "/").startsWith("/")
    ? trimmed.replace(/\\/g, "/")
    : `/${trimmed.replace(/\\/g, "/")}`;
  const collapsed = withLeadingSlash.replace(/\/+/g, "/");
  const segments = collapsed.split("/");
  if (segments.some((segment) => segment === "..")) {
    return null;
  }

  if (collapsed === "/") {
    return "/";
  }

  return collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
}

export function validateMountSessionBody(payload: unknown): {
  ok: true;
  value: ValidatedMountSessionBody;
} | {
  ok: false;
  error: ValidationErrorCode;
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "invalid_request" };
  }

  const body = payload as Record<string, unknown>;
  const localDir = validateMountLocalDir(body.localDir);
  if (!localDir) {
    return { ok: false, error: "invalid_local_dir" };
  }

  const remotePath = normalizeMountRemotePath(body.remotePath);
  if (!remotePath) {
    return { ok: false, error: "invalid_remote_path" };
  }

  const mode = body.mode === undefined ? "poll" : body.mode;
  if (mode !== "poll" && mode !== "fuse") {
    return { ok: false, error: "invalid_mode" };
  }

  if (
    body.agentName !== undefined &&
    (typeof body.agentName !== "string" || !body.agentName.trim())
  ) {
    return { ok: false, error: "invalid_request" };
  }

  if (
    body.scopes !== undefined &&
    (!Array.isArray(body.scopes) || !body.scopes.every((scope) => typeof scope === "string"))
  ) {
    return { ok: false, error: "invalid_request" };
  }

  if (body.provider !== undefined && typeof body.provider !== "string") {
    return { ok: false, error: "invalid_request" };
  }

  return {
    ok: true,
    value: {
      localDir,
      remotePath,
      mode,
      agentName:
        typeof body.agentName === "string" && body.agentName.trim()
          ? body.agentName.trim()
          : DEFAULT_MOUNT_AGENT_NAME,
      ...(Array.isArray(body.scopes) ? { scopes: body.scopes } : {}),
      ...(typeof body.provider === "string" ? { provider: body.provider.trim() } : {}),
    },
  };
}

export function callerAllowsRequestedScopes(
  auth: RequestAuth,
  requestedScopes: readonly string[] | undefined,
): boolean {
  if (!requestedScopes?.length || auth.source === "session") {
    return true;
  }

  const requested = requestedScopes
    .map((scope) => normalizeRequestedRelayfileScope(scope))
    .filter((scope): scope is NormalizedRelayfileScope => scope !== null);
  // Deny when caller passed scopes that did not normalize. Returning true here
  // would let an `fs:read`-only JWT escalate to read+write by sending
  // non-relayfile scope strings (e.g. `relayauth:token:manage:*`) — downstream
  // `compileJoinAccess` swaps an empty normalized list for the default
  // read+write fallback.
  if (requested.length === 0) {
    return false;
  }

  const grants = readScopeGrants(auth);
  if (grants.length === 0) {
    return false;
  }

  return requested.every((scope) =>
    grants.some((grant) =>
      grant.action === scope.action && pathGrantCovers(grant.path, scope.path),
    ),
  );
}

export function requestedMountSessionScopes(input: {
  remotePath: string;
  scopes?: readonly string[];
}): string[] | undefined {
  if (input.scopes !== undefined) {
    return resilienceScopeList(input.scopes);
  }

  const normalized = normalizeRelayfilePath(input.remotePath);
  if (!normalized || normalized === "/**") {
    return undefined;
  }

  const scoped = mountPathScope(normalized);
  const resilienceScoped = resilienceScopedRelayfileMountPaths([scoped]);
  if (resilienceScoped.length === 1 && resilienceScoped[0] === scoped) {
    return undefined;
  }

  return relayfileScopesForMountPaths(resilienceScoped);
}

function resilienceScopeList(scopes: readonly string[]): string[] {
  return [...new Set(scopes.flatMap((scope) => {
    const match = scope.match(RELAYFILE_FS_SCOPE);
    if (!match) {
      return [scope];
    }
    const resilienceScoped = resilienceScopedRelayfileMountPaths([match[2] ?? ""]);
    if (resilienceScoped.length === 0) {
      return [scope];
    }
    return relayfileScopesForMountPaths(
      resilienceScoped,
      match[1].toLowerCase() as ScopeAction,
    );
  }))];
}

function relayfileScopesForMountPaths(
  paths: readonly string[],
  action?: ScopeAction,
): string[] {
  const actions: ScopeAction[] = action ? [action] : ["read", "write"];
  return resilienceScopedRelayfileMountPaths(paths)
    .flatMap((path) =>
      actions.map((entry) => `relayfile:fs:${entry}:${path}`)
    );
}

function mountPathScope(path: string): string {
  return path.endsWith("/**") ? path : `${path}/**`;
}
