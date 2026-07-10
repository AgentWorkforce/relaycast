import cleanupCronWorker from "../src/cleanup-cron.js";
import {
  cleanupStaleWorkspaces,
  deleteWorkspaceContent,
  purgeWorkspaceCompletely,
} from "../src/cleanup.js";

function createR2Bucket(
  pages: Array<{
    objects: Array<{ key: string }>;
    truncated: boolean;
    cursor?: string;
  }>,
) {
  const deleted: string[][] = [];
  let index = 0;

  return {
    bucket: {
      async list() {
        const page = pages[index] ?? {
          objects: [],
          truncated: false,
          cursor: undefined,
        };
        index += 1;
        return page;
      },
      async delete(keys: string[] | string) {
        deleted.push(Array.isArray(keys) ? keys : [keys]);
      },
    } as unknown as R2Bucket,
    deleted,
  };
}

// Prefix-aware R2 bucket mock: unlike createR2Bucket (which replays fixed
// pages), this honors the `prefix` passed to list() the same way the real
// R2 binding does, so it can prove deleteWorkspaceContent never reaches
// across a workspace-id boundary.
function createPrefixAwareR2Bucket(seedKeys: string[]) {
  const store = new Set(seedKeys);
  const deleted: string[] = [];

  return {
    store,
    deleted,
    bucket: {
      async list(opts?: { prefix?: string }) {
        const prefix = opts?.prefix ?? "";
        const objects = [...store]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key }));
        return { objects, truncated: false, cursor: undefined };
      },
      async delete(keys: string[] | string) {
        const list = Array.isArray(keys) ? keys : [keys];
        for (const key of list) {
          store.delete(key);
          deleted.push(key);
        }
      },
    } as unknown as R2Bucket,
  };
}

function createDb(workspaceIds: string[]) {
  const deleted: Array<{ table: string; workspaceId: string }> = [];

  return {
    deleted,
    db: {
      prepare(query: string) {
        return {
          bind(...bindings: unknown[]) {
            return {
              async all<T>() {
                if (query.includes("SELECT workspace_id")) {
                  return {
                    results: workspaceIds.map((workspaceId) => ({
                      workspace_id: workspaceId,
                    })) as T[],
                  };
                }
                return { results: [] as T[] };
              },
              async run() {
                const workspaceId = String(bindings[0] ?? "");
                const match = query.match(/DELETE FROM ([a-z_]+)/i);
                if (match) {
                  deleted.push({ table: match[1], workspaceId });
                }
                return {};
              },
            };
          },
        };
      },
      async batch(statements: Array<{ run: () => Promise<unknown> }>) {
        await Promise.all(statements.map((statement) => statement.run()));
        return [];
      },
    } as unknown as D1Database,
  };
}

function createWorkspaceNamespace() {
  const cleaned: string[] = [];

  return {
    cleaned,
    namespace: {
      idFromName(name: string) {
        return name as unknown as DurableObjectId;
      },
      get(id: DurableObjectId) {
        return {
          async fetch(request: Request) {
            cleaned.push(id as unknown as string);
            return new Response(
              JSON.stringify({
                workspaceId: request.headers.get("X-Workspace-Id"),
                status: "cleaned",
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          },
        } as DurableObjectStub;
      },
    } as DurableObjectNamespace,
  };
}

describe("relayfile cleanup", () => {
  it("deletes stale workspace content across paginated R2 listings", async () => {
    const { bucket, deleted } = createR2Bucket([
      {
        objects: [{ key: "ws_123/file-a" }, { key: "ws_123/file-b" }],
        truncated: true,
        cursor: "page-2",
      },
      {
        objects: [{ key: "ws_123/file-c" }],
        truncated: false,
      },
    ]);

    const count = await deleteWorkspaceContent(bucket, "ws_123");

    expect(count).toBe(3);
    expect(deleted).toEqual([
      ["ws_123/file-a", "ws_123/file-b"],
      ["ws_123/file-c"],
    ]);
  });

  it("removes stale workspaces from R2, durable object state, and D1 metadata", async () => {
    const { bucket } = createR2Bucket([
      {
        objects: [{ key: "ws_stale/file-a" }],
        truncated: false,
      },
    ]);
    const { db, deleted } = createDb(["ws_stale"]);
    const { namespace, cleaned } = createWorkspaceNamespace();

    const result = await cleanupStaleWorkspaces({
      CONTENT_BUCKET: bucket,
      DB: db,
      WORKSPACE_DO: namespace,
    });

    expect(result).toEqual({ cleanedWorkspaces: 1, deletedObjects: 1 });
    expect(cleaned).toEqual(["ws_stale"]);
    expect(deleted).toEqual([
      { table: "dead_letters", workspaceId: "ws_stale" },
      { table: "webhook_envelopes", workspaceId: "ws_stale" },
      { table: "webhook_delivery_dead_letters", workspaceId: "ws_stale" },
      { table: "workspace_operations", workspaceId: "ws_stale" },
      { table: "sync_refresh_jobs", workspaceId: "ws_stale" },
      { table: "workspace_stats", workspaceId: "ws_stale" },
    ]);
  });

  it("purgeWorkspaceCompletely tears down R2 + DO + D1 for one workspace", async () => {
    const { bucket, deleted } = createR2Bucket([
      {
        objects: [{ key: "rw_abcd1234/a@1" }, { key: "rw_abcd1234/b@2" }],
        truncated: true,
        cursor: "p2",
      },
      { objects: [{ key: "rw_abcd1234/c@3" }], truncated: false },
    ]);
    const { db, deleted: dbDeleted } = createDb([]);
    const { namespace, cleaned } = createWorkspaceNamespace();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await purgeWorkspaceCompletely(
      { CONTENT_BUCKET: bucket, DB: db, WORKSPACE_DO: namespace },
      "rw_abcd1234",
    );

    expect(result.deletedObjects).toBe(3);
    expect(result.doCleaned).toBe(true);
    expect(result.metadataCleaned).toBe(true);
    expect(deleted.flat()).toEqual([
      "rw_abcd1234/a@1",
      "rw_abcd1234/b@2",
      "rw_abcd1234/c@3",
    ]);
    expect(cleaned).toContain("rw_abcd1234");
    expect(dbDeleted.map((d) => d.table)).toEqual(
      expect.arrayContaining([
        "dead_letters",
        "webhook_envelopes",
        "workspace_operations",
        "sync_refresh_jobs",
        "workspace_stats",
      ]),
    );
    log.mockRestore();
  });

  it("purgeWorkspaceCompletely still purges DO+D1 when R2 deletion fails", async () => {
    const failingBucket = {
      async list() {
        throw new Error("R2 down");
      },
      async delete() {},
    } as unknown as R2Bucket;
    const { db } = createDb([]);
    const { namespace } = createWorkspaceNamespace();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await purgeWorkspaceCompletely(
      { CONTENT_BUCKET: failingBucket, DB: db, WORKSPACE_DO: namespace },
      "rw_xyz",
    );

    expect(result.deletedObjects).toBe(0);
    expect(result.doCleaned).toBe(true);
    expect(result.metadataCleaned).toBe(true);
    log.mockRestore();
    err.mockRestore();
  });

  it("never deletes a prefix-colliding bystander workspace's R2 keys", async () => {
    // Real key shape: `${workspaceId}${normalizePath(path)}@${revision}`,
    // i.e. `${workspaceId}/<path>@<rev>`. deleteWorkspaceContent lists with
    // prefix `${workspaceId}/`. Two co-resident workspaces whose ids are
    // string-prefixes of each other must not bleed into each other:
    //   - target:   rw_abcdef00  (fixed-length unified id)
    //   - bystander: rw_abcdef01 (same length, shares "rw_abcdef0" prefix)
    //   - strictPrefix: rw_abcdef000 — id is a STRICT prefix of nothing of
    //     the target, but the target id "rw_abcdef00" is a strict prefix of
    //     "rw_abcdef000"; the trailing "/" boundary is what prevents
    //     "rw_abcdef000/bar@1" from matching prefix "rw_abcdef00/".
    const target = "rw_abcdef00";
    const bystander = "rw_abcdef01";
    const strictPrefix = "rw_abcdef000";

    const targetKeys = [
      `${target}/foo@1`,
      `${target}/foo@2`,
      `${target}/nested/bar@1`,
    ];
    const bystanderKeys = [`${bystander}/foo@1`, `${bystander}/nested/bar@1`];
    const strictPrefixKeys = [`${strictPrefix}/foo@1`, `${strictPrefix}/bar@1`];

    const { bucket, store, deleted } = createPrefixAwareR2Bucket([
      ...targetKeys,
      ...bystanderKeys,
      ...strictPrefixKeys,
    ]);

    const count = await deleteWorkspaceContent(bucket, target);

    expect(count).toBe(targetKeys.length);
    // Only the target's keys were deleted.
    expect(deleted.sort()).toEqual([...targetKeys].sort());
    // Both prefix-colliding bystanders are fully intact.
    for (const key of [...bystanderKeys, ...strictPrefixKeys]) {
      expect(store.has(key)).toBe(true);
    }
    for (const key of targetKeys) {
      expect(store.has(key)).toBe(false);
    }
  });

  it("purgeWorkspaceCompletely only purges the target across a prefix collision", async () => {
    const target = "rw_abcdef00";
    const bystander = "rw_abcdef01";
    const strictPrefix = "rw_abcdef000";

    const targetKeys = [`${target}/a@1`, `${target}/b@2`];
    const bystanderKeys = [`${bystander}/a@1`];
    const strictPrefixKeys = [`${strictPrefix}/a@1`];

    const { bucket, store, deleted } = createPrefixAwareR2Bucket([
      ...targetKeys,
      ...bystanderKeys,
      ...strictPrefixKeys,
    ]);
    const { db } = createDb([]);
    const { namespace } = createWorkspaceNamespace();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await purgeWorkspaceCompletely(
      { CONTENT_BUCKET: bucket, DB: db, WORKSPACE_DO: namespace },
      target,
    );

    expect(result.deletedObjects).toBe(targetKeys.length);
    expect(deleted.sort()).toEqual([...targetKeys].sort());
    for (const key of [...bystanderKeys, ...strictPrefixKeys]) {
      expect(store.has(key)).toBe(true);
    }
    log.mockRestore();
  });

  it("logs the number of cleaned stale workspaces from the scheduled handler", async () => {
    const { bucket } = createR2Bucket([{ objects: [], truncated: false }]);
    const { db } = createDb([]);
    const { namespace } = createWorkspaceNamespace();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await cleanupCronWorker.scheduled(
      {} as ScheduledEvent,
      {
        CONTENT_BUCKET: bucket,
        DB: db,
        WORKSPACE_DO: namespace,
      } as unknown as Parameters<typeof cleanupCronWorker.scheduled>[1],
      {} as ExecutionContext,
    );

    expect(log).toHaveBeenCalledWith("Cleaned up 0 stale workspaces");
    log.mockRestore();
  });
});
