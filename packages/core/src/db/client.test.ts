import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  nodeDrizzle: vi.fn((pool: unknown, opts: unknown) => ({
    _kind: "node-postgres-drizzle",
    pool,
    opts,
  })),
  neonDrizzle: vi.fn((pool: unknown, opts: unknown) => ({
    _kind: "neon-serverless-drizzle",
    pool,
    opts,
    transaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
      callback({ _kind: "neon-serverless-tx" }),
    ),
  })),
  neonHttpDrizzle: vi.fn((sql: unknown, opts: unknown) => ({
    _kind: "neon-http-drizzle",
    sql,
    opts,
    transaction: vi.fn(),
  })),
  PgPool: vi.fn(function PgPool(config: unknown) {
    return { _kind: "pg-pool", config };
  }),
  NeonPool: vi.fn(function NeonPool(config: unknown) {
    return {
      _kind: "neon-pool",
      config,
      connect: vi.fn(async () => ({ release: vi.fn() })),
      end: vi.fn(async () => undefined),
      on: vi.fn(),
    };
  }),
  neon: vi.fn((connectionString: string) => ({
    _kind: "neon-http-sql",
    connectionString,
  })),
  neonConfig: {
    fetchFunction: undefined as unknown,
  },
}));

vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: mocks.nodeDrizzle,
}));

vi.mock("drizzle-orm/neon-serverless", () => ({
  drizzle: mocks.neonDrizzle,
}));

vi.mock("drizzle-orm/neon-http", () => ({
  drizzle: mocks.neonHttpDrizzle,
}));

vi.mock("pg", () => ({
  Pool: mocks.PgPool,
}));

vi.mock("@neondatabase/serverless", () => ({
  Pool: mocks.NeonPool,
  neon: mocks.neon,
  neonConfig: mocks.neonConfig,
}));

// Resource has no usable value in tests; all connection strings flow through
// DATABASE_URL (connection.ts prefers it).
vi.mock("sst", () => ({
  Resource: {
    NeonDatabaseUrl: { value: "" },
  },
}));

vi.mock("./schema.js", () => ({
  workspaceIntegrations: {
    workspaceId: "workspace_id",
    provider: "provider",
    metadataJson: "metadata_json",
    updatedAt: "updated_at",
  },
}));

const CF_CTX = Symbol.for("__cloudflare-context__");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_NAVIGATOR = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function setRequestContext(ctx: object | undefined): void {
  if (ctx === undefined) {
    delete (globalThis as Record<symbol, unknown>)[CF_CTX];
    return;
  }
  Object.defineProperty(globalThis, CF_CTX, { configurable: true, value: ctx });
}

function setNavigatorUserAgent(userAgent: string | undefined): void {
  if (userAgent === undefined) {
    if (ORIGINAL_NAVIGATOR) {
      Object.defineProperty(globalThis, "navigator", ORIGINAL_NAVIGATOR);
    } else {
      delete (globalThis as { navigator?: unknown }).navigator;
    }
    return;
  }
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent },
  });
}

function createProviderReadinessDb() {
  const row = {
    workspaceId: "ws_123",
    provider: "confluence",
    metadataJson: "{}",
  };
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [row],
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: async () => ({ rows: [], rowCount: 1 }),
      }),
    }),
  };
}

describe("core db client runtime selection", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.neonConfig.fetchFunction = undefined;
    delete process.env.DATABASE_URL;
    delete globalThis.__appDbPool;
    delete globalThis.__appDbOverride;
    setRequestContext(undefined);
    setNavigatorUserAgent(undefined);
  });

  afterEach(() => {
    process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    delete globalThis.__appDbPool;
    delete globalThis.__appDbOverride;
    vi.unstubAllGlobals();
    setRequestContext(undefined);
    setNavigatorUserAgent(undefined);
  });

  it("uses node-postgres with TLS for a remote (Neon) connection string on Lambda", async () => {
    process.env.DATABASE_URL = "postgres://user:pw@ep.neon.tech/db?sslmode=require";
    const { getDb, readCoreDbRuntimeDiagnosticSnapshot } = await import("./client.js");

    const db = getDb();

    expect(db).toMatchObject({ _kind: "node-postgres-drizzle" });
    expect(mocks.PgPool).toHaveBeenCalledWith({
      connectionString: "postgres://user:pw@ep.neon.tech/db?sslmode=require",
      max: 10,
      ssl: { rejectUnauthorized: false },
    });
    expect(mocks.nodeDrizzle).toHaveBeenCalledTimes(1);
    expect(mocks.NeonPool).not.toHaveBeenCalled();
    expect(readCoreDbRuntimeDiagnosticSnapshot()).toMatchObject({
      selectedDbClient: "node-postgres",
      hasDatabaseUrl: true,
      hasNeonConnectionString: true,
    });
  });

  it("disables TLS for a localhost connection string", async () => {
    process.env.DATABASE_URL = "postgres://postgres@localhost:5432/db";
    const { getDb } = await import("./client.js");

    getDb();

    expect(mocks.PgPool).toHaveBeenCalledWith({
      connectionString: "postgres://postgres@localhost:5432/db",
      max: 10,
    });
    expect(mocks.NeonPool).not.toHaveBeenCalled();
  });

  it("converts pooled Neon URLs to direct URLs for session-pinned callers", async () => {
    const { toDirectNeonConnectionString } = await import("./connection.js");

    expect(
      toDirectNeonConnectionString(
        "postgres://user:pw@ep-red-tree-123-pooler.us-east-1.aws.neon.tech/db?sslmode=require",
      ),
    ).toBe(
      "postgres://user:pw@ep-red-tree-123.us-east-1.aws.neon.tech/db?sslmode=require",
    );
  });

  it("leaves local connection strings unchanged when asking for a direct Neon URL", async () => {
    const { toDirectNeonConnectionString } = await import("./connection.js");

    expect(
      toDirectNeonConnectionString("postgres://postgres@localhost:5432/db"),
    ).toBe("postgres://postgres@localhost:5432/db");
  });

  it("uses the Neon HTTP driver for ordinary queries on the Worker runtime", async () => {
    process.env.DATABASE_URL = "postgres://user:pw@ep.neon.tech/db?sslmode=require";
    setRequestContext({ env: {} });
    const { getDb, readCoreDbRuntimeDiagnosticSnapshot } = await import("./client.js");

    const db = getDb();

    expect(db).toMatchObject({ _kind: "neon-http-drizzle" });
    expect(mocks.neon).toHaveBeenCalledWith(
      "postgres://user:pw@ep.neon.tech/db?sslmode=require",
    );
    expect(mocks.neonConfig.fetchFunction).toEqual(expect.any(Function));
    expect(mocks.neonHttpDrizzle).toHaveBeenCalledTimes(1);
    expect(mocks.NeonPool).not.toHaveBeenCalled();
    expect(mocks.neonDrizzle).not.toHaveBeenCalled();
    expect(mocks.PgPool).not.toHaveBeenCalled();
    expect(readCoreDbRuntimeDiagnosticSnapshot()).toMatchObject({
      selectedDbClient: "neon-worker",
      cloudflareContextHasEnv: true,
    });
  });

  it("binds Neon HTTP fetch through globalThis for Worker compatibility", async () => {
    process.env.DATABASE_URL = "postgres://user:pw@ep.neon.tech/db?sslmode=require";
    setRequestContext({ env: {} });
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const { getDb } = await import("./client.js");

    getDb();
    const fetchFunction = mocks.neonConfig.fetchFunction as typeof globalThis.fetch;
    await fetchFunction("https://example.test/sql", { method: "POST" });

    expect(fetchMock).toHaveBeenCalledWith("https://example.test/sql", {
      method: "POST",
    });
  });

  it("uses an explicitly closed Neon serverless pool for each Worker transaction", async () => {
    process.env.DATABASE_URL = "postgres://user:pw@ep.neon.tech/db?sslmode=require";
    setRequestContext({ env: {} });
    const { getDb } = await import("./client.js");

    const db = getDb();

    await db.transaction(async (tx) => tx);
    await db.transaction(async (tx) => tx);

    expect(mocks.NeonPool).toHaveBeenCalledTimes(2);
    expect(mocks.NeonPool).toHaveBeenNthCalledWith(1, {
      connectionString: "postgres://user:pw@ep.neon.tech/db?sslmode=require",
      connectionTimeoutMillis: 3_000,
      idleTimeoutMillis: 1,
      max: 1,
      maxUses: 1,
    });
    const firstPool = mocks.NeonPool.mock.results[0]?.value as {
      end: ReturnType<typeof vi.fn>;
    };
    const secondPool = mocks.NeonPool.mock.results[1]?.value as {
      end: ReturnType<typeof vi.fn>;
    };
    expect(firstPool.end).toHaveBeenCalledTimes(1);
    expect(secondPool.end).toHaveBeenCalledTimes(1);
    expect(mocks.neonDrizzle).toHaveBeenCalledTimes(2);
    expect(mocks.PgPool).not.toHaveBeenCalled();
  });

  it("reuses one Neon client per request context", async () => {
    process.env.DATABASE_URL = "postgres://user:pw@ep.neon.tech/db";
    setRequestContext({ env: {}, reqId: "A" });
    const { getDb } = await import("./client.js");

    getDb();
    getDb();
    getDb();

    expect(mocks.neonHttpDrizzle).toHaveBeenCalledTimes(1);
    expect(mocks.NeonPool).not.toHaveBeenCalled();
  });

  it("fails fast on a Worker cold miss with no connection string", async () => {
    setNavigatorUserAgent("Cloudflare-Workers");
    const { getDb, readCoreDbRuntimeDiagnosticSnapshot } = await import("./client.js");

    expect(() => getDb()).toThrow(
      "[db] Neon connection string unavailable on worker runtime",
    );
    expect(mocks.PgPool).not.toHaveBeenCalled();
    expect(mocks.NeonPool).not.toHaveBeenCalled();
    expect(readCoreDbRuntimeDiagnosticSnapshot()).toMatchObject({
      selectedDbClient: "worker-neon-unavailable",
      navigatorUserAgent: "Cloudflare-Workers",
    });
  });

  it("honors setDbForTesting before any runtime branch", async () => {
    setNavigatorUserAgent("Cloudflare-Workers");
    const { getDb, setDbForTesting } = await import("./client.js");
    const override = { _kind: "override-db" };

    setDbForTesting(override as never);

    expect(getDb()).toBe(override);
    expect(mocks.PgPool).not.toHaveBeenCalled();
    expect(mocks.NeonPool).not.toHaveBeenCalled();
  });

  it("keeps nango sync worker readiness calls on node-postgres outside Worker", async () => {
    process.env.DATABASE_URL = "postgres://user:pw@ep.neon.tech/db?sslmode=require";
    mocks.nodeDrizzle.mockReturnValue(createProviderReadinessDb() as never);
    const { markProviderInitialSyncRunning } = await import("../provider-readiness.js");

    await markProviderInitialSyncRunning({
      workspaceId: "ws_123",
      provider: "confluence",
      syncName: "fetch-pages",
      model: "Page",
    });

    expect(mocks.PgPool).toHaveBeenCalledWith({
      connectionString: "postgres://user:pw@ep.neon.tech/db?sslmode=require",
      max: 10,
      ssl: { rejectUnauthorized: false },
    });
    expect(mocks.nodeDrizzle).toHaveBeenCalled();
    expect(mocks.NeonPool).not.toHaveBeenCalled();
  });
});
