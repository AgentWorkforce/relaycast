import {
  relayfilePathsForProviderTrigger,
  relayfileProviderRoot,
} from "./provider-contracts.js";

export type RelayfileTriggerDescriptor =
  | string
  | Record<string, unknown>;

export type RelayfileTriggerIntegrations = Record<
  string,
  { triggers?: RelayfileTriggerDescriptor[] }
>;

export class RelayfilePathScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayfilePathScopeError";
  }
}

const GITHUB_REPO_METADATA_MOUNT_PATHS = [
  "/github/repos/*/*/checks/**",
  "/github/repos/*/*/issues/**",
  "/github/repos/*/*/pulls/**",
] as const;

export function normalizeRelayfilePath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed === "*" || trimmed === "/*" || trimmed === "/**") {
    return "";
  }

  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const collapsed = withLeadingSlash.replace(/\/+/g, "/");
  if (collapsed.endsWith("/")) {
    return `${collapsed.slice(0, -1)}/**`;
  }
  return collapsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTriggerName(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }

  if (!isRecord(value)) {
    return null;
  }

  for (const key of ["on", "event", "type", "name"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return normalizeTriggerName(value.trigger);
}

function normalizePathArray(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => normalizeRelayfilePath(entry))
    .filter(Boolean);
}

function triggerWatchPaths(value: unknown): {
  paths: string[];
  hadExplicitWatchPaths: boolean;
} {
  if (!isRecord(value)) {
    return { paths: [], hadExplicitWatchPaths: false };
  }

  const paths = new Set<string>();
  let hadExplicitWatchPaths = false;
  for (const key of [
    "watchGlobs",
    "watchGlob",
    "watch_globs",
    "watch_glob",
    "watchPaths",
    "watchPath",
    "watch_paths",
    "watch_path",
    "paths",
    "path",
    "relayfilePaths",
    "relayfilePath",
    "relayfile_paths",
    "relayfile_path",
  ]) {
    if (key in value && value[key] != null) {
      hadExplicitWatchPaths = true;
    }
    for (const path of normalizePathArray(value[key])) {
      paths.add(path);
    }
  }

  const nested = triggerWatchPaths(value.trigger);
  hadExplicitWatchPaths ||= nested.hadExplicitWatchPaths;
  for (const path of nested.paths) {
    paths.add(path);
  }

  return { paths: [...paths], hadExplicitWatchPaths };
}

function normalizedProviderName(provider: string): string {
  return provider.trim().toLowerCase();
}

function validateProviderWatchPaths(provider: string, paths: readonly string[]): string[] {
  const root = relayfileProviderRoot(provider);
  if (!root) {
    throw new RelayfilePathScopeError(
      `Unsupported relayfile integration provider "${provider}"`,
    );
  }

  const invalid = paths.find((path) => path !== root && !path.startsWith(`${root}/`));
  if (invalid) {
    throw new RelayfilePathScopeError(
      `Relayfile watch path "${invalid}" is outside provider root "${root}"`,
    );
  }

  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

function mappedPathsForTrigger(provider: string, trigger: string): string[] {
  const paths = relayfilePathsForProviderTrigger(provider, trigger);
  if (paths.length === 0) {
    throw new RelayfilePathScopeError(
      `Unsupported relayfile integration provider "${provider}"`,
    );
  }

  return paths;
}

export function relayfilePathsForTrigger(
  provider: string,
  trigger: RelayfileTriggerDescriptor,
): string[] {
  const { paths: watchPaths, hadExplicitWatchPaths } = triggerWatchPaths(trigger);
  if (hadExplicitWatchPaths && watchPaths.length === 0) {
    throw new RelayfilePathScopeError(
      `Relayfile trigger for provider "${provider}" declared watch paths but none were valid`,
    );
  }
  if (watchPaths.length > 0) {
    return validateProviderWatchPaths(provider, watchPaths);
  }

  const triggerName = normalizeTriggerName(trigger);
  if (!triggerName) {
    throw new RelayfilePathScopeError(
      `Relayfile trigger for provider "${provider}" must declare trigger.on`,
    );
  }

  return validateProviderWatchPaths(provider, mappedPathsForTrigger(provider, triggerName));
}

export function relayfilePathsForIntegrations(
  integrations?: RelayfileTriggerIntegrations,
): string[] {
  const paths = new Set<string>();
  for (const [provider, config] of Object.entries(integrations ?? {})) {
    for (const trigger of config.triggers ?? []) {
      for (const path of relayfilePathsForTrigger(provider, trigger)) {
        paths.add(path);
      }
    }
  }

  return [...paths].sort((left, right) => left.localeCompare(right));
}

export function relayfileScopesFromPaths(paths: readonly string[]): string[] {
  return [...new Set(
    paths
      .map((path) => normalizeRelayfilePath(path))
      .filter(Boolean)
      .flatMap((path) => [
        `relayfile:fs:read:${path}`,
        `relayfile:fs:write:${path}`,
      ]),
  )];
}

export function relayfilePathTokenScopes(scopes?: readonly string[]): string[] {
  const normalized = (scopes ?? [])
    .map((scope) => scope.trim())
    .map((scope) => {
      const match = /^relayfile:fs:(read|write):(.+)$/.exec(scope);
      if (!match) {
        return null;
      }
      const path = normalizeRelayfilePath(match[2] ?? "");
      return path ? `relayfile:fs:${match[1]}:${path}` : null;
    })
    .filter((scope): scope is string => Boolean(scope));

  return [...new Set(normalized)];
}

export function resilienceScopedRelayfileMountPaths(paths: readonly string[]): string[] {
  return [...new Set(
    paths
      .map((path) => normalizeRelayfilePath(path))
      .filter(Boolean)
      .flatMap((path) => (
        isBroadGithubReposMountPath(path)
          ? GITHUB_REPO_METADATA_MOUNT_PATHS
          : [path]
      )),
  )].sort((left, right) => left.localeCompare(right));
}

function isBroadGithubReposMountPath(path: string): boolean {
  return path === "/github/repos" || path === "/github/repos/**";
}

export function relayfilePathTokenPaths(scopes: readonly string[]): string[] {
  const paths = scopes
    .map((scope) => scope.split(":").slice(3).join(":"))
    .map((path) => normalizeRelayfilePath(path))
    .filter(Boolean);

  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}
