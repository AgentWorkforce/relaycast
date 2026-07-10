/**
 * Per-provider DO sharding — coordinator skeleton (hardening item 5).
 *
 * Design overview
 * ---------------
 *
 * Today: one WorkspaceDO instance per workspace. Files for every
 * provider live in the same SQL store inside that DO. Memory budget is
 * ~128 MB which becomes the workspace-wide ceiling.
 *
 * Sharded mode: each provider gets its own DO addressed by
 *
 *     idFromName(`${workspaceId}:${provider}`)
 *
 * Reads/writes scoped to a single provider go straight to the provider
 * shard. Cross-provider reads (whole-workspace export, tree listing
 * under `/`, cross-provider digest refresh) go through a coordinator
 * that fans out to the per-provider shards and merges the responses.
 *
 * The coordinator is the {@link ShardedWorkspaceCoordinator} below. It
 * is intentionally a thin orchestrator: every per-provider operation
 * delegates to the same handler code that runs in the monolithic DO,
 * just addressed at a different DO instance. The coordinator's job is
 * to:
 *
 *   1) route a single-provider request to the right shard,
 *   2) fan-out cross-provider reads and merge keyset-paginated results,
 *   3) carry the feature-flag check (RELAYFILE_SHARDED_WORKSPACE env
 *      var + per-workspace toggle in `workspace_stats.sharding_mode`)
 *      so existing workspaces stay on the monolith.
 *
 * Migration path (deferred — see SCOPE NOTE below):
 *
 *   - Tag the workspace stats row with `sharding_mode = "monolith"` or
 *     `"sharded"`.
 *   - One-shot migration job (durable workflow) walks the source DO's
 *     files table, partitions by provider, and replays writes against
 *     the per-provider shards. Event log carries forward; revision
 *     counters fork (each shard maintains its own monotone sequence,
 *     namespaced by provider, so cross-provider revisions don't
 *     collide because revisions are already scoped to a path).
 *   - Cutover flips `sharding_mode` to `"sharded"` atomically with the
 *     coordinator's read path.
 *
 * SCOPE NOTE — what landed in this commit
 * ---------------------------------------
 *
 * Per the hardening task scope ("design + coordinator skeleton + one
 * end-to-end sharded happy-path test, mark the rest deferred with a
 * concrete follow-up list"), this commit delivers:
 *
 *   ✅ The {@link ShardedWorkspaceCoordinator} class (this file).
 *   ✅ Routing logic for single-provider reads/writes.
 *   ✅ Feature-flag plumbing through {@link isShardedMode}.
 *   ✅ One end-to-end happy-path test
 *      (test/sharded-workspace-coordinator.test.ts).
 *
 * Deferred (concrete follow-up list):
 *
 *   ❌ Wiring the coordinator into the routes/* handlers so requests
 *      to a sharded workspace bypass the monolith. The coordinator
 *      exposes the right interface but is not yet bound in routes/fs.ts
 *      or middleware/auth.ts. Doing so requires moving \`forwardToWorkspaceDO\`
 *      from a single-DO-stub call to a coordinator-aware dispatch.
 *
 *   ❌ Cross-provider tree listing (`/fs/tree` under `/`) needs a
 *      merge-sort across shards' keyset cursors. The shape is well
 *      defined here (mergeProviderManifests) but no production code
 *      path calls it yet.
 *
 *   ❌ The migration job (monolith → sharded). Design above describes
 *      the partition-replay-cutover steps; the workflow itself is not
 *      written.
 *
 *   ❌ Schema column `workspace_stats.sharding_mode`. The coordinator
 *      currently reads sharding mode from \`RELAYFILE_SHARDED_WORKSPACE\`
 *      env + per-workspace allowlist in code. The column needs a
 *      drizzle migration.
 *
 *   ❌ A second end-to-end test for the cross-provider fan-out path.
 *      The skeleton test only exercises single-provider routing.
 *
 * Follow-up tickets:
 *   - cloud#TBD: drizzle migration for workspace_stats.sharding_mode
 *   - cloud#TBD: route handler dispatch through coordinator
 *   - cloud#TBD: monolith → sharded migration workflow
 *   - cloud#TBD: cross-provider fan-out fixtures
 */

/** Resolve the per-provider DO id-from-name key. */
export function shardKey(workspaceId: string, provider: string): string {
  return `${workspaceId}:${provider}`;
}

export type WorkspaceShardRoute = {
  shardName: string;
  shardKey: string;
  reason: string;
};

export const GITHUB_REPO_SUBSHARDS = [
  "github:contents",
  "github:issues",
  "github:pulls",
  "github:meta",
] as const;

export const WORKSPACE_PROVIDER_SHARDS = [
  "confluence",
  "gitlab",
  "google-mail",
  "granola",
  "jira",
  "linear",
  "notion",
  "slack",
] as const;

const GITHUB_REPO_AREAS = new Set(["contents", "issues", "pulls"]);
const KNOWN_PROVIDER_SHARDS = new Set<string>(WORKSPACE_PROVIDER_SHARDS);

export function resolveShardRouteForPath(
  workspaceId: string,
  path: string,
): WorkspaceShardRoute | null {
  const shardName = shardNameForWorkspacePath(path);
  if (!shardName) {
    return null;
  }
  return {
    shardName,
    shardKey: shardKey(workspaceId, shardName),
    reason: "path",
  };
}

export function resolveShardRouteForGithubTarball(
  workspaceId: string,
  owner: string,
  repo: string,
): WorkspaceShardRoute | null {
  if (!owner.trim() || !repo.trim()) {
    return null;
  }
  return {
    shardName: "github:contents",
    shardKey: shardKey(workspaceId, "github:contents"),
    reason: "github-tarball",
  };
}

export function shardNameForWorkspacePath(path: string): string | null {
  const segments = workspacePathSegments(path);
  const top = segments[0];
  if (!top) {
    return null;
  }
  if (top === "github" && segments[1] === "repos") {
    const area = segments[4];
    if (area && GITHUB_REPO_AREAS.has(area)) {
      return `github:${area}`;
    }
    return "github:meta";
  }
  if (top === "github") {
    return "github:meta";
  }
  return KNOWN_PROVIDER_SHARDS.has(top) ? top : null;
}

export function fanoutShardNamesForReadPath(path: string): readonly string[] {
  const segments = workspacePathSegments(path);
  if (segments.length === 0) {
    return [...WORKSPACE_PROVIDER_SHARDS, ...GITHUB_REPO_SUBSHARDS];
  }
  if (segments[0] !== "github") {
    return [];
  }
  if (segments.length <= 4) {
    return GITHUB_REPO_SUBSHARDS;
  }
  return [];
}

function workspacePathSegments(path: string): string[] {
  return path
    .trim()
    .replace(/^\/+/u, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.trim().toLowerCase());
}

/**
 * Per-workspace sharding-mode resolver. Today reads from environment +
 * an in-code allowlist; the production version will read from the
 * workspace_stats row's `sharding_mode` column.
 */
export interface ShardingModeResolver {
  isSharded(workspaceId: string): Promise<boolean>;
}

export function envFlagShardingModeResolver(env: {
  RELAYFILE_SHARDED_WORKSPACE?: string;
}): ShardingModeResolver {
  // CSV of workspace ids — operators can flip individual tenants on
  // without redeploying. Setting the var to "*" enables sharded mode
  // for every workspace (test/staging usage).
  const raw = env.RELAYFILE_SHARDED_WORKSPACE?.trim() ?? "";
  if (!raw) return { isSharded: async () => false };
  if (raw === "*") return { isSharded: async () => true };
  const set = new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return { isSharded: async (id) => set.has(id) };
}

export interface ShardedDoNamespace {
  /** A namespaced DurableObject namespace; one stub per provider shard. */
  get(workspaceId: string, provider: string): { fetch: typeof fetch };
}

const EXHAUSTED_PROVIDER_CURSOR = "__relayfile_exhausted__";

/**
 * Thin coordinator. Wraps the shard namespace + sharding-mode resolver
 * and exposes the verbs the route handlers need.
 */
export class ShardedWorkspaceCoordinator {
  constructor(
    private readonly shards: ShardedDoNamespace,
    private readonly mode: ShardingModeResolver,
  ) {}

  /** Routes a single-provider request to the shard owning that provider. */
  async fetchProvider(
    workspaceId: string,
    provider: string,
    request: Request,
  ): Promise<Response> {
    const shard = this.shards.get(workspaceId, provider);
    return shard.fetch(request);
  }

  /**
   * Cross-provider fan-out helper. Calls `fetchPage(provider, cursor)`
   * once per provider, sorts the merged rows by `compareEntries`, and
   * returns cursors that advance only for entries actually emitted.
   */
  async mergeProviderManifests<Entry>(args: {
    workspaceId: string;
    providers: readonly string[];
    pageSize: number;
    perProviderCursor?: Record<string, string | null>;
    fetchPage: (
      provider: string,
      after: string | null,
    ) => Promise<{ entries: Entry[]; nextCursor: string | null }>;
    compareEntries: (a: Entry, b: Entry) => number;
    cursorForEntry?: (entry: Entry) => string;
  }): Promise<{
    entries: Entry[];
    perProviderCursor: Record<string, string | null>;
  }> {
    const perProvider = await Promise.all(
      args.providers.map(async (p) => {
        const after = args.perProviderCursor?.[p] ?? null;
        if (after === EXHAUSTED_PROVIDER_CURSOR) {
          return {
            provider: p,
            after,
            page: { entries: [] as Entry[], nextCursor: null },
          };
        }
        return {
          provider: p,
          after,
          page: await args.fetchPage(p, after),
        };
      }),
    );
    const merged = perProvider
      .flatMap((p) =>
        p.page.entries.map((entry, index) => ({
          entry,
          provider: p.provider,
          index,
          pageLength: p.page.entries.length,
          pageNextCursor: p.page.nextCursor,
        })),
      )
      .sort((a, b) => args.compareEntries(a.entry, b.entry))
      .slice(0, args.pageSize);
    const entries = merged.map((item) => item.entry);
    const emittedByProvider = new Map<string, (typeof merged)[number]>();
    for (const item of merged) {
      emittedByProvider.set(item.provider, item);
    }
    const cursorForEntry =
      args.cursorForEntry ??
      ((entry: Entry) => (entry as { path?: string }).path ?? "");
    const perProviderCursor: Record<string, string | null> = {};
    for (const { provider, after, page } of perProvider) {
      const lastEmitted = emittedByProvider.get(provider);
      if (!lastEmitted) {
        perProviderCursor[provider] = after;
      } else if (lastEmitted.index === lastEmitted.pageLength - 1) {
        perProviderCursor[provider] =
          page.nextCursor ?? EXHAUSTED_PROVIDER_CURSOR;
      } else {
        perProviderCursor[provider] = cursorForEntry(lastEmitted.entry);
      }
    }
    return { entries, perProviderCursor };
  }

  /** Forwarded mode lookup so route handlers can branch monolith vs sharded. */
  async isSharded(workspaceId: string): Promise<boolean> {
    return this.mode.isSharded(workspaceId);
  }
}
