/**
 * Explicit VFS write/read plane resolver.
 *
 * This is the shared contract for the integration write-plane split:
 * callers ask which plane owns a path before deciding admission, queueing,
 * DO routing, or read fan-out. The initial rollout keeps legacy storage
 * behaviour but emits dark metrics against this resolver.
 */

import { WORKSPACE_PROVIDER_SHARDS } from "./sharding.js";

export type VfsPlane = "runtime-code" | "integration";

export type VfsPlaneRoute = {
  plane: VfsPlane;
  provider?: string;
  shardKey: string;
  reason: string;
};

const INTEGRATION_ROOTS = new Set([...WORKSPACE_PROVIDER_SHARDS, "memory"]);

export function resolveVfsPlaneRoute(
  workspaceId: string,
  path: unknown,
): VfsPlaneRoute {
  const normalized = normalizeWorkspacePath(path);
  const segments = workspacePathSegments(normalized);
  const top = segments[0];

  if (
    normalized === "/.relayfile/clone.json" ||
    (top === "github" &&
      segments[1] === "repos" &&
      segments.length >= 5 &&
      segments[4] === "contents")
  ) {
    return runtimeRoute(workspaceId, "code-root");
  }

  if (top === "discovery") {
    const provider = segments[1];
    if (provider && INTEGRATION_ROOTS.has(provider)) {
      return integrationRoute(workspaceId, provider, "discovery-provider");
    }
    return runtimeRoute(workspaceId, "discovery-unknown-provider");
  }

  if (top && INTEGRATION_ROOTS.has(top)) {
    return integrationRoute(workspaceId, top, "provider-root");
  }

  return runtimeRoute(workspaceId, top ? "runtime-default" : "workspace-root");
}

export function normalizeWorkspacePath(path: unknown): string {
  if (typeof path !== "string") return "/";
  const trimmed = path.trim();
  if (!trimmed) return "/";
  const normalized = `/${trimmed.replace(/^\/+/u, "")}`
    .replace(/\/{2,}/gu, "/")
    .replace(/\/$/u, "");
  return normalized || "/";
}

export function vfsPlaneLogLabels(
  route: VfsPlaneRoute,
): Record<string, string> {
  return {
    plane: route.plane,
    provider: route.provider ?? "",
    shard_key: route.shardKey,
    reason: route.reason,
  };
}

function integrationRoute(
  workspaceId: string,
  provider: string,
  reason: string,
): VfsPlaneRoute {
  return {
    plane: "integration",
    provider,
    shardKey: `${workspaceId}:integration:${provider}`,
    reason,
  };
}

function runtimeRoute(workspaceId: string, reason: string): VfsPlaneRoute {
  return {
    plane: "runtime-code",
    shardKey: `${workspaceId}:runtime-code`,
    reason,
  };
}

function workspacePathSegments(normalizedPath: string): string[] {
  return normalizedPath
    .slice(1)
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.trim().toLowerCase());
}
