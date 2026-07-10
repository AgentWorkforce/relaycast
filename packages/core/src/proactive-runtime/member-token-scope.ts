export class MemberTokenScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemberTokenScopeError";
  }
}

export type MemberScopeAssignment = {
  memberName: string;
  assignedPaths: readonly string[];
};

const RELAYFILE_WRITE_PREFIX = "relayfile:fs:write:";
const RELAYFILE_READ_PREFIX = "relayfile:fs:read:";
const RELAYFILE_MANAGE_PREFIX = "relayfile:fs:manage:";

export function memberWritePath(root: string): string {
  const normalized = assertSafeMemberWritePath(root);
  if (normalized.endsWith("/*") || normalized.endsWith("/**")) {
    return normalized;
  }
  return `${normalized}/*`;
}

export function assertSafeMemberWritePath(root: string): string {
  const normalized = normalizeMemberRoot(root);
  if (normalized.split("/").includes("..")) {
    throw new MemberTokenScopeError(`Member path root "${root}" contains path traversal`);
  }
  return normalized;
}

export function pathScope(root: string): string {
  return `${RELAYFILE_WRITE_PREFIX}${memberWritePath(root)}`;
}

export function readPathScope(root: string): string {
  return `${RELAYFILE_READ_PREFIX}${memberWritePath(root)}`;
}

export function validateMemberWriteScopes(
  scopes: readonly string[],
  assignedRoots: readonly string[],
): string[] {
  const expected = expectedWriteScopeCounts(assignedRoots);
  const seen = new Map<string, number>();

  for (const rawScope of scopes) {
    const scope = rawScope.trim();
    if (!scope) {
      continue;
    }
    rejectKnownBroadWriteScope(scope);

    if (!scope.startsWith(RELAYFILE_WRITE_PREFIX)) {
      continue;
    }

    if (!expected.has(scope)) {
      throw new MemberTokenScopeError(
        `Invalid member write scope "${scope}"; expected exactly one assigned path scope`,
      );
    }
    seen.set(scope, (seen.get(scope) ?? 0) + 1);
  }

  if (seen.size === 0) {
    throw new MemberTokenScopeError("At least one exact member write scope is required");
  }

  for (const [scope, count] of seen) {
    if (count > 1) {
      throw new MemberTokenScopeError(`Duplicate member write scope "${scope}"`);
    }
  }

  for (const scope of expected.keys()) {
    if (!seen.has(scope)) {
      throw new MemberTokenScopeError(`Missing member write scope "${scope}"`);
    }
  }

  return [...seen.keys()].sort((left, right) => left.localeCompare(right));
}

export function validateMemberRelayfileAccessScopes(
  scopes: readonly string[],
  assignedRoots: readonly string[],
): string[] {
  const writeScopes = validateMemberWriteScopes(scopes, assignedRoots);
  const allowedReadScopes = new Set(assignedRoots.map((root) => readPathScope(root)));
  const allowedWriteScopes = new Set(writeScopes);

  for (const rawScope of scopes) {
    const scope = rawScope.trim();
    if (!scope) {
      continue;
    }
    rejectKnownBroadWriteScope(scope);
    rejectKnownBroadReadScope(scope);

    if (scope.startsWith(RELAYFILE_READ_PREFIX) && !allowedReadScopes.has(scope)) {
      throw new MemberTokenScopeError(
        `Invalid member read scope "${scope}"; expected only assigned path read scopes`,
      );
    }
    if (scope.startsWith(RELAYFILE_READ_PREFIX) && allowedReadScopes.has(scope)) {
      continue;
    }
    if (scope.startsWith(RELAYFILE_WRITE_PREFIX) && allowedWriteScopes.has(scope)) {
      continue;
    }
    throw new MemberTokenScopeError(
      `Invalid member scope "${scope}"; expected only assigned relayfile read/write scopes`,
    );
  }

  return writeScopes;
}

export function assertPairwiseDisjointScopes(
  assignments: readonly MemberScopeAssignment[],
): void {
  if (assignments.length === 0) {
    throw new MemberTokenScopeError("At least one member scope assignment is required");
  }

  const emptyAssignment = assignments.find((assignment) => assignment.assignedPaths.length === 0);
  if (emptyAssignment) {
    throw new MemberTokenScopeError(
      `At least one assigned path is required for member "${emptyAssignment.memberName}"`,
    );
  }

  const entries = assignments.flatMap((assignment) =>
    assignment.assignedPaths.map((path) => ({
      memberName: assignment.memberName,
      path,
      coverage: coverageForRoot(path),
    }))
  );

  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const left = entries[i];
      const right = entries[j];
      if (!left || !right || !coveragesOverlap(left.coverage, right.coverage)) {
        continue;
      }
      throw new MemberTokenScopeError(
        `Assigned member scopes overlap: ${left.memberName} "${left.path}" and ${right.memberName} "${right.path}"`,
      );
    }
  }
}

export function assertMountedLocalRootWithinAssigned(
  scopedWriteRoots: readonly string[],
  assignedPaths: readonly string[],
): void {
  if (scopedWriteRoots.length === 0) {
    throw new MemberTokenScopeError("At least one mounted local root is required");
  }

  const assigned = assignedPaths.map((path) => coverageForRoot(path));
  if (assigned.length === 0) {
    throw new MemberTokenScopeError("At least one assigned path is required");
  }

  for (const scopedRoot of scopedWriteRoots) {
    const rootCoverage = coverageForRoot(scopedRoot);
    const covered = assigned.some((assignedCoverage) =>
      coverageContains(assignedCoverage, rootCoverage),
    );
    if (!covered) {
      throw new MemberTokenScopeError(
        `Mounted local root "${scopedRoot}" is outside assigned paths`,
      );
    }
  }
}

function expectedWriteScopeCounts(assignedRoots: readonly string[]): Map<string, number> {
  if (assignedRoots.length === 0) {
    throw new MemberTokenScopeError("At least one assigned path is required");
  }

  const expected = new Map<string, number>();
  for (const assignedRoot of assignedRoots) {
    const scope = pathScope(assignedRoot);
    expected.set(scope, (expected.get(scope) ?? 0) + 1);
  }

  for (const [scope, count] of expected) {
    if (count > 1) {
      throw new MemberTokenScopeError(`Duplicate assigned member write root "${scope}"`);
    }
  }

  return expected;
}

function rejectKnownBroadWriteScope(scope: string): void {
  if (
    scope === "admin" ||
    scope === "fs:write" ||
    scope.startsWith("fs:write:") ||
    scope === "fs:manage" ||
    scope.startsWith("fs:manage:") ||
    scope.startsWith("admin:") ||
    scope.startsWith(RELAYFILE_MANAGE_PREFIX)
  ) {
    throw new MemberTokenScopeError(`Broad member write scope "${scope}" is not allowed`);
  }

  if (
    scope === "relayfile:fs:write" ||
    scope === "relayfile:fs:manage" ||
    scope === `${RELAYFILE_WRITE_PREFIX}*` ||
    scope === `${RELAYFILE_WRITE_PREFIX}/*` ||
    scope === `${RELAYFILE_WRITE_PREFIX}/**`
  ) {
    throw new MemberTokenScopeError(`Broad member write scope "${scope}" is not allowed`);
  }
}

function rejectKnownBroadReadScope(scope: string): void {
  if (
    scope === "fs:read" ||
    scope.startsWith("fs:read:") ||
    scope === "relayfile:fs:read" ||
    scope === `${RELAYFILE_READ_PREFIX}*` ||
    scope === `${RELAYFILE_READ_PREFIX}/*` ||
    scope === `${RELAYFILE_READ_PREFIX}/**`
  ) {
    throw new MemberTokenScopeError(`Broad member read scope "${scope}" is not allowed`);
  }
}

function normalizeMemberRoot(root: string): string {
  const trimmed = root.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed === "*") {
    throw new MemberTokenScopeError("Member path root must be a non-root relayfile path");
  }

  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const collapsed = withLeadingSlash.replace(/\/{2,}/g, "/");
  if (collapsed === "/" || collapsed === "/*" || collapsed === "/**") {
    throw new MemberTokenScopeError("Member path root must be a non-root relayfile path");
  }
  if (collapsed.endsWith("/**") || collapsed.endsWith("/*")) {
    return collapsed;
  }

  const withoutTrailingSlash = collapsed.replace(/\/+$/u, "");
  if (
    !withoutTrailingSlash ||
    withoutTrailingSlash === "/" ||
    withoutTrailingSlash === "/*" ||
    withoutTrailingSlash === "/**"
  ) {
    throw new MemberTokenScopeError("Member path root must be a non-root relayfile path");
  }
  return withoutTrailingSlash;
}

function coverageForRoot(root: string): string {
  const normalized = normalizeMemberRoot(root);
  if (normalized.endsWith("/**")) {
    return normalized.slice(0, -3);
  }
  if (normalized.endsWith("/*")) {
    return normalized.slice(0, -2);
  }
  return normalized;
}

function coveragesOverlap(left: string, right: string): boolean {
  return coverageContains(left, right) || coverageContains(right, left);
}

function coverageContains(container: string, candidate: string): boolean {
  return container === candidate || candidate.startsWith(`${container}/`);
}
