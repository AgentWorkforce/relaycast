import type { AppContext } from "../env.js";
import {
  envFlagShardingModeResolver,
  resolveShardRouteForGithubTarball,
  resolveShardRouteForPath,
  type WorkspaceShardRoute,
} from "../durable-objects/sharding.js";
import { getWorkspaceStub } from "../middleware/auth.js";

type ShardRoutingLogContext = {
  operation?: string;
  path?: string;
};

export async function getWorkspaceStubForPath(
  c: AppContext,
  workspaceId: string,
  path: string,
  logContext: ShardRoutingLogContext = {},
): Promise<{ stub: DurableObjectStub; route: WorkspaceShardRoute | null }> {
  const route = await resolveEnabledShardRoute(
    c,
    workspaceId,
    () => resolveShardRouteForPath(workspaceId, path),
    { ...logContext, path },
  );
  if (!route) {
    return { stub: getWorkspaceStub(c, workspaceId), route: null };
  }
  return { stub: getShardStub(c, route), route };
}

export async function getGithubTarballWorkspaceStub(
  c: AppContext,
  workspaceId: string,
  owner: string,
  repo: string,
): Promise<{ stub: DurableObjectStub; route: WorkspaceShardRoute | null }> {
  const route = await resolveEnabledShardRoute(c, workspaceId, () =>
    resolveShardRouteForGithubTarball(workspaceId, owner, repo),
  );
  if (!route) {
    return { stub: getWorkspaceStub(c, workspaceId), route: null };
  }
  return { stub: getShardStub(c, route), route };
}

async function resolveEnabledShardRoute(
  c: AppContext,
  workspaceId: string,
  route: () => WorkspaceShardRoute | null,
  logContext: ShardRoutingLogContext = {},
): Promise<WorkspaceShardRoute | null> {
  const sharded = await envFlagShardingModeResolver(c.env).isSharded(
    workspaceId,
  );
  if (!sharded) {
    return null;
  }
  const resolved = route();
  if (resolved && c.env.RELAYFILE_LOG_SHARD_ROUTING === "1") {
    const workspaceHash = await shortSha256(workspaceId);
    const pathHash = logContext.path
      ? await shortSha256(logContext.path)
      : undefined;
    console.info("relayfile.shard_routing", {
      workspaceHash,
      shardName: resolved.shardName,
      doName: resolved.shardKey,
      reason: resolved.reason,
      operation: logContext.operation,
      pathHash,
    });
  }
  return resolved;
}

function getShardStub(
  c: AppContext,
  route: WorkspaceShardRoute,
): DurableObjectStub {
  const id = c.env.WORKSPACE_DO.idFromName(route.shardKey);
  return c.env.WORKSPACE_DO.get(id);
}

async function shortSha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest).slice(0, 8), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
