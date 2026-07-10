import {
  DEFAULT_SYSTEM_PERMISSIONS,
  type AgentPermissions,
  type SystemPermissions,
} from '../types/permissions.js';

const DEFAULT_REQUESTED_SCOPES = [
  'relayfile:fs:read:*',
  'relayfile:fs:write:*',
] as const;
const ORCHESTRATOR_AGENT_NAME = 'cloud-orchestrator';
const GLOB_PATTERN = /[*?\[]/;

type RequestedScope = {
  action: 'read' | 'write';
  path: string;
  raw: string;
};

type PermissionPattern = {
  scopePath: string;
};

export interface CompiledAgentPermissions {
  agentName: string;
  scopes: string[];
  aclRules: Record<string, string[]>;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function mergePermissionLists(
  ...values: Array<readonly string[] | undefined>
): string[] | undefined {
  const merged = unique(values.flatMap((value) => value ?? []));
  return merged.length > 0 ? merged : undefined;
}

export function mergeAgentPermissions(
  agentPerms: AgentPermissions = {},
  systemPerms: SystemPermissions = DEFAULT_SYSTEM_PERMISSIONS,
): AgentPermissions {
  const ignored = mergePermissionLists(
    agentPerms.ignored,
    systemPerms.alwaysIgnored,
  );
  const readonly = mergePermissionLists(
    agentPerms.readonly,
    systemPerms.alwaysReadonly,
  );

  return {
    ...(ignored ? { ignored } : {}),
    ...(readonly ? { readonly } : {}),
  };
}

function normalizePath(input: string): string {
  const trimmed = input.trim().replace(/\\/g, '/');
  if (!trimmed || trimmed === '/') {
    return '/';
  }

  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const collapsed = withLeadingSlash.replace(/\/+/g, '/');
  return collapsed.length > 1 && collapsed.endsWith('/')
    ? collapsed.slice(0, -1)
    : collapsed;
}

function normalizeGlobPattern(input: string): string {
  const trimmed = input.trim().replace(/\\/g, '/');
  if (!trimmed || trimmed === '/' || trimmed === '*' || trimmed === '**') {
    return '*';
  }

  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+/g, '/');
}

function normalizeRequestedScopePath(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || trimmed === '*' || trimmed === '/*' || trimmed === '/**') {
    return '*';
  }

  if (trimmed.endsWith('/**')) {
    const base = normalizePath(trimmed.slice(0, -3));
    return base === '/' ? '*' : `${base}/*`;
  }

  if (trimmed.endsWith('/*')) {
    const base = normalizePath(trimmed.slice(0, -2));
    return base === '/' ? '*' : `${base}/*`;
  }

  if (trimmed.endsWith('/')) {
    const base = normalizePath(trimmed.slice(0, -1));
    return base === '/' ? '*' : `${base}/*`;
  }

  if (GLOB_PATTERN.test(trimmed)) {
    return normalizeGlobPattern(trimmed);
  }

  return normalizePath(trimmed);
}

function normalizePermissionPattern(input: string): PermissionPattern | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  if (
    trimmed === '*' ||
    trimmed === '**' ||
    trimmed === '/*' ||
    trimmed === '/**' ||
    trimmed === '**/*'
  ) {
    return { scopePath: '*' };
  }

  if (trimmed.endsWith('/**')) {
    const base = normalizePath(trimmed.slice(0, -3));
    return {
      scopePath: base === '/' ? '*' : `${base}/*`,
    };
  }

  if (trimmed.endsWith('/*')) {
    const base = normalizePath(trimmed.slice(0, -2));
    return {
      scopePath: base === '/' ? '*' : `${base}/*`,
    };
  }

  if (trimmed.endsWith('/')) {
    const base = normalizePath(trimmed.slice(0, -1));
    return {
      scopePath: base === '/' ? '*' : `${base}/*`,
    };
  }

  if (!GLOB_PATTERN.test(trimmed)) {
    return {
      scopePath: normalizePath(trimmed),
    };
  }

  return {
    scopePath: normalizeGlobPattern(trimmed),
  };
}

function normalizeRequestedScope(raw: string): RequestedScope | null {
  const parts = raw.split(':');
  if (parts.length < 3 || parts.length > 4) {
    return null;
  }

  const [plane, resource, actionRaw, pathRaw] = parts;
  const action = actionRaw?.trim().toLowerCase();
  if (plane !== 'relayfile' || resource !== 'fs') {
    return null;
  }
  if (action !== 'read' && action !== 'write') {
    return null;
  }

  const path = normalizeRequestedScopePath(pathRaw ?? '*');
  if (!path) {
    return null;
  }

  return {
    action,
    path,
    raw: `relayfile:fs:${action}:${path}`,
  };
}

function normalizeRequestedScopes(baseScopes?: readonly string[]): RequestedScope[] {
  const result = [
    ...new Map(
      (baseScopes && baseScopes.length > 0 ? baseScopes : DEFAULT_REQUESTED_SCOPES)
        .map((scope) => normalizeRequestedScope(scope))
        .filter((scope): scope is RequestedScope => scope !== null)
        .map((scope) => [scope.raw, scope]),
    ).values(),
  ];

  // Fall back to defaults if all requested scopes were non-relayfile and got filtered out
  if (result.length === 0) {
    return [
      ...new Map(
        DEFAULT_REQUESTED_SCOPES
          .map((scope) => normalizeRequestedScope(scope))
          .filter((scope): scope is RequestedScope => scope !== null)
          .map((scope) => [scope.raw, scope]),
      ).values(),
    ];
  }

  return result;
}

function normalizePermissionPatterns(values?: readonly string[]): PermissionPattern[] {
  const patterns: PermissionPattern[] = [];
  for (const value of values ?? []) {
    const normalized = normalizePermissionPattern(value);
    if (normalized) {
      patterns.push(normalized);
    }
  }
  return patterns;
}

function pathCoversScope(scopePath: string, targetPath: string): boolean {
  if (scopePath === '*') {
    return true;
  }

  if (targetPath === '*') {
    return scopePath === '*';
  }

  if (scopePath.endsWith('/*')) {
    // slice removes trailing '*', keeping the '/' — e.g. '/etc/*' → '/etc/'
    // This ensures '/etcpasswd' does NOT match (requires the path separator)
    return targetPath.startsWith(scopePath.slice(0, -1));
  }

  if (GLOB_PATTERN.test(scopePath)) {
    if (targetPath.endsWith('/*')) {
      return false;
    }
    return globPatternToRegExp(scopePath).test(targetPath);
  }

  if (targetPath.endsWith('/*')) {
    return false;
  }

  return scopePath === targetPath;
}

function scopeIntersectsPath(scopePath: string, targetPath: string): boolean {
  if (scopePath === '*' || targetPath === '*') {
    return true;
  }

  if (
    (GLOB_PATTERN.test(scopePath) || GLOB_PATTERN.test(targetPath)) &&
    (scopePath.endsWith('/*') || targetPath.endsWith('/*'))
  ) {
    return true;
  }

  return pathCoversScope(scopePath, targetPath) || pathCoversScope(targetPath, scopePath);
}

// NOTE: This is a minimal glob-to-regex converter that handles *, **, and ?.
// It does NOT support character classes ([abc]), negation (!), or brace expansion ({a,b}).
// The GLOB_PATTERN regex above detects `[` as a glob indicator, but this converter
// treats `[` as a literal character. If richer glob support is needed, replace with
// a battle-tested library such as picomatch.
function globPatternToRegExp(pattern: string): RegExp {
  let regex = '^';

  for (let index = 0; index < pattern.length; ) {
    if (pattern.startsWith('**/', index)) {
      regex += '(?:.*/)?';
      index += 3;
      continue;
    }
    if (pattern.startsWith('**', index)) {
      regex += '.*';
      index += 2;
      continue;
    }

    const char = pattern[index] ?? '';
    if (char === '*') {
      regex += '[^/]*';
      index += 1;
      continue;
    }
    if (char === '?') {
      regex += '[^/]';
      index += 1;
      continue;
    }

    regex += escapeRegExp(char);
    index += 1;
  }

  regex += '$';
  return new RegExp(regex);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function filterEffectiveScopes(
  scopes: RequestedScope[],
  ignoredPatterns: PermissionPattern[],
  readonlyPatterns: PermissionPattern[],
): RequestedScope[] {
  return scopes.filter((scope) => {
    if (ignoredPatterns.some((pattern) => pathCoversScope(pattern.scopePath, scope.path))) {
      return false;
    }

    if (
      scope.action === 'write' &&
      readonlyPatterns.some((pattern) => pathCoversScope(pattern.scopePath, scope.path))
    ) {
      return false;
    }

    return true;
  });
}

function collectOverrideTargets(
  ignoredPatterns: PermissionPattern[],
  readonlyPatterns: PermissionPattern[],
): string[] {
  return unique([
    ...ignoredPatterns.map((pattern) => pattern.scopePath),
    ...readonlyPatterns.map((pattern) => pattern.scopePath),
  ]);
}

function buildPrivateScope(
  agentName: string,
  action: RequestedScope['action'],
  path: string,
): string {
  return `workspace:${agentName}:${action}:${path}`;
}

function buildAclRules(
  agentName: string,
  effectiveScopes: RequestedScope[],
  ignoredPatterns: PermissionPattern[],
  readonlyPatterns: PermissionPattern[],
): Record<string, string[]> {
  const allowScopes = new Set<string>();
  const denyScopes = new Set<string>();

  for (const scope of effectiveScopes) {
    allowScopes.add(buildPrivateScope(agentName, scope.action, scope.path));
  }

  for (const targetPath of collectOverrideTargets(ignoredPatterns, readonlyPatterns)) {
    for (const scope of effectiveScopes) {
      if (!scopeIntersectsPath(scope.path, targetPath)) {
        continue;
      }

      const denyIgnored = ignoredPatterns.some((pattern) =>
        pathCoversScope(pattern.scopePath, targetPath),
      );
      const denyReadonly =
        scope.action === 'write' &&
        readonlyPatterns.some((pattern) => pathCoversScope(pattern.scopePath, targetPath));

      if (!denyIgnored && !denyReadonly) {
        continue;
      }

      denyScopes.add(buildPrivateScope(agentName, scope.action, targetPath));
    }
  }

  const rootPermissions = unique([
    ...[...allowScopes].map((scope) => `allow:scope:${scope}`),
    ...[...denyScopes].map((scope) => `deny:scope:${scope}`),
  ]);

  if (rootPermissions.length === 0) {
    return {};
  }

  return {
    '/': unique([`allow:agent:${ORCHESTRATOR_AGENT_NAME}`, ...rootPermissions]),
  };
}

function buildTokenScopes(
  effectiveScopes: RequestedScope[],
  aclRules: Record<string, string[]>,
): string[] {
  const scopes = new Set<string>();
  const hasRead = effectiveScopes.some((scope) => scope.action === 'read');
  const hasWrite = effectiveScopes.some((scope) => scope.action === 'write');

  if (hasRead) {
    scopes.add('fs:read');
    scopes.add('sync:read');
  }
  if (hasWrite) {
    scopes.add('fs:write');
  }

  for (const permission of aclRules['/'] ?? []) {
    if (!permission.startsWith('allow:scope:') && !permission.startsWith('deny:scope:')) {
      continue;
    }
    scopes.add(permission.replace(/^(allow|deny):scope:/, ''));
  }

  return unique([...scopes]);
}

export function compileAgentPermissions(
  agentName: string,
  agentPerms: AgentPermissions = {},
  systemPerms: SystemPermissions = DEFAULT_SYSTEM_PERMISSIONS,
  baseScopes?: readonly string[],
): CompiledAgentPermissions {
  const mergedPermissions = mergeAgentPermissions(agentPerms, systemPerms);
  const requestedScopes = normalizeRequestedScopes(baseScopes);
  const ignoredPatterns = normalizePermissionPatterns(mergedPermissions.ignored);
  const readonlyPatterns = normalizePermissionPatterns(mergedPermissions.readonly);
  const effectiveScopes = filterEffectiveScopes(
    requestedScopes,
    ignoredPatterns,
    readonlyPatterns,
  );
  const aclRules = buildAclRules(
    agentName,
    effectiveScopes,
    ignoredPatterns,
    readonlyPatterns,
  );

  return {
    agentName,
    scopes: buildTokenScopes(effectiveScopes, aclRules),
    aclRules,
  };
}
