import { relayfilePathTokenPaths } from "@cloud/core/relayfile/path-scopes.js";
import type { WorkspacePermissions } from "@cloud/core/workspace/registry.js";
import {
  areValidRequestedScopes,
  compileJoinAccess,
} from "@/lib/relay-workspaces";

export type RelayfileDelegatedTokenRequest = {
  agentName?: string;
  agentId?: string | null;
  scopes?: string[];
  relayfileMountPaths?: string[];
  ttlSeconds?: number;
  delegationTtlSeconds?: number;
};

export type RelayfileDelegatedTokenBody = {
  agentName: string;
  agentId?: string | null;
  relayfileMountPaths: string[];
  relayfileScopes: string[];
  relayfileAclPermissions: string[];
  requestedScopes?: string[];
  ttlSeconds: number;
  delegationTtlSeconds: number;
};

export const DEFAULT_RELAYFILE_DELEGATED_TOKEN_AGENT = "relayfile-local";
export const DEFAULT_RELAYFILE_DELEGATED_TOKEN_TTL_SECONDS = 60 * 60;
export const MAX_RELAYFILE_DELEGATED_TOKEN_TTL_SECONDS = 60 * 60;
export const DEFAULT_RELAYFILE_DELEGATED_TOKEN_DELEGATION_TTL_SECONDS = 24 * 60 * 60;
export const MAX_RELAYFILE_DELEGATED_TOKEN_DELEGATION_TTL_SECONDS = 24 * 60 * 60;

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

function normalizeSeconds(
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

// Maps the relayfile CLI's coarse `fs:` plane scopes onto the 4-segment
// `relayfile:` plane the RelayAuth strict mint chain requires. Two shapes the
// CLI emits today:
//   - Bare action (legacy join):     `fs:read`               → `relayfile:fs:read:*`
//   - Path-scoped (writeback push):  `fs:write:/linear/**`   → `relayfile:fs:write:/linear/**`
// The path-scoped form was added with relayfile v0.8.30's `relayfile writeback
// push` (AR-272) and was not previously normalized here, so the contract gate
// at `normalizeRequestedScopes` rejected the whole body — see the regression
// test in route.test.ts.
const CLI_PATH_SCOPED_FS_SCOPE = /^fs:(read|write):(\/.*)$/i;
function normalizeCliCoarseRelayfileScope(scope: string): string {
  const trimmed = scope.trim();
  if (trimmed === "fs:read") {
    return "relayfile:fs:read:*";
  }
  if (trimmed === "fs:write") {
    return "relayfile:fs:write:*";
  }
  const pathMatch = trimmed.match(CLI_PATH_SCOPED_FS_SCOPE);
  if (pathMatch) {
    return `relayfile:fs:${pathMatch[1].toLowerCase()}:${pathMatch[2]}`;
  }
  return trimmed;
}

function normalizeRequestedScopes(value: unknown): string[] | null {
  if (!areValidRequestedScopes(value)) {
    return null;
  }

  const scopes = value.map(normalizeCliCoarseRelayfileScope);
  if (!scopes.some((scope) => scope.startsWith("relayfile:fs:"))) {
    return null;
  }
  return scopes;
}

function requestedRelayfileScopesForMountPaths(
  relayfileMountPaths: readonly string[],
  requestedScopes: readonly string[] | undefined,
): string[] {
  const actions = new Set<"read" | "write">();
  if (!requestedScopes) {
    actions.add("read");
    actions.add("write");
  } else {
    for (const scope of requestedScopes) {
      if (scope.startsWith("relayfile:fs:read:")) {
        actions.add("read");
      } else if (scope.startsWith("relayfile:fs:write:")) {
        actions.add("write");
      }
    }
  }

  return relayfileMountPaths.flatMap((path) => [
    ...(actions.has("read") ? [`relayfile:fs:read:${path}`] : []),
    ...(actions.has("write") ? [`relayfile:fs:write:${path}`] : []),
  ]);
}

function effectiveRelayfileMountPathAccess(input: {
  agentName: string;
  relayfileMountPaths: readonly string[];
  requestedScopes: readonly string[] | undefined;
  permissions: WorkspacePermissions;
}): {
  relayfileMountPaths: string[];
  relayfileScopes: string[];
  relayfileAclPermissions: string[];
} {
  const requestedPathScopes = requestedRelayfileScopesForMountPaths(
    input.relayfileMountPaths,
    input.requestedScopes,
  );
  const compiled = compileJoinAccess(input.agentName, requestedPathScopes, input.permissions);
  const relayfileScopes = compiled.publicScopes;
  const relayfileMountPaths = relayfilePathTokenPaths(relayfileScopes);
  const relayfileAclPermissions = compiled.aclPermissions.filter((permission) =>
    permission.startsWith("deny:scope:"),
  );
  return { relayfileMountPaths, relayfileScopes, relayfileAclPermissions };
}

export function relayfileMountPathsFromDelegatedTokenScopes(input: {
  agentName: string;
  scopes: readonly string[];
  permissions: WorkspacePermissions;
}): { relayfileMountPaths: string[]; relayfileScopes: string[] } {
  const compiled = compileJoinAccess(input.agentName, input.scopes, input.permissions);
  const relayfileMountPaths = relayfilePathTokenPaths(compiled.publicScopes);
  return {
    relayfileMountPaths,
    relayfileScopes: relayfileMountPaths.length > 0 ? compiled.publicScopes : compiled.tokenScopes,
  };
}

export function parseRelayfileDelegatedTokenRequest(
  value: unknown,
  options: {
    permissions: WorkspacePermissions;
    normalizeRelayfileMountPaths: (value: readonly string[] | undefined) => string[];
  },
): RelayfileDelegatedTokenBody | null {
  if (!isRecord(value)) {
    return null;
  }

  const agentName = normalizeOptionalString(value.agentName) ?? DEFAULT_RELAYFILE_DELEGATED_TOKEN_AGENT;
  const ttlSeconds = normalizeSeconds(value.ttlSeconds, {
    defaultSeconds: DEFAULT_RELAYFILE_DELEGATED_TOKEN_TTL_SECONDS,
    maxSeconds: MAX_RELAYFILE_DELEGATED_TOKEN_TTL_SECONDS,
  });
  const delegationTtlSeconds = normalizeSeconds(value.delegationTtlSeconds, {
    defaultSeconds: DEFAULT_RELAYFILE_DELEGATED_TOKEN_DELEGATION_TTL_SECONDS,
    maxSeconds: MAX_RELAYFILE_DELEGATED_TOKEN_DELEGATION_TTL_SECONDS,
  });
  if (ttlSeconds === null || delegationTtlSeconds === null) {
    return null;
  }
  const requestedScopes = value.scopes === undefined
    ? undefined
    : normalizeRequestedScopes(value.scopes);
  if (requestedScopes === null) {
    return null;
  }

  if (value.relayfileMountPaths !== undefined) {
    if (
      !Array.isArray(value.relayfileMountPaths) ||
      !value.relayfileMountPaths.every((entry) => typeof entry === "string")
    ) {
      return null;
    }
    const relayfileMountPaths = options.normalizeRelayfileMountPaths(value.relayfileMountPaths);
    if (relayfileMountPaths.length === 0) {
      return null;
    }
    const access = effectiveRelayfileMountPathAccess({
      agentName,
      relayfileMountPaths,
      requestedScopes,
      permissions: options.permissions,
    });
    const { relayfileScopes } = access;
    if (relayfileScopes.length === 0) {
      return null;
    }
    return {
      agentName,
      agentId: normalizeOptionalString(value.agentId),
      relayfileMountPaths: access.relayfileMountPaths,
      relayfileScopes,
      relayfileAclPermissions: access.relayfileAclPermissions,
      requestedScopes,
      ttlSeconds,
      delegationTtlSeconds,
    };
  }

  if (!requestedScopes) {
    return null;
  }

  const { relayfileMountPaths, relayfileScopes } = relayfileMountPathsFromDelegatedTokenScopes({
    agentName,
    scopes: requestedScopes,
    permissions: options.permissions,
  });
  if (relayfileScopes.length === 0) {
    return null;
  }

  return {
    agentName,
    agentId: normalizeOptionalString(value.agentId),
    relayfileMountPaths,
    relayfileScopes,
    relayfileAclPermissions: [],
    requestedScopes,
    ttlSeconds,
    delegationTtlSeconds,
  };
}
