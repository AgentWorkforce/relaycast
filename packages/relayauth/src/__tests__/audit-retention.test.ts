import assert from "node:assert/strict";
import test from "node:test";

import { mockD1 } from "./test-helpers.js";

type AuditRetentionConfig = {
  orgId: string;
  retentionDays: number;
};

type AuditRetentionModule = {
  purgeExpiredEntries: (
    db: D1Database,
    retentionDays?: number,
  ) => Promise<number | { deletedCount: number }> | number | { deletedCount: number };
  countExpiredEntries: (
    db: D1Database,
    retentionDays?: number,
  ) => Promise<number | { expiredCount: number; count?: number } | { count: number }> |
    number |
    { expiredCount: number; count?: number } |
    { count: number };
  getRetentionConfig: (
    db: D1Database,
    orgId: string,
  ) => Promise<AuditRetentionConfig> | AuditRetentionConfig;
  setRetentionConfig: (
    db: D1Database,
    orgId: string,
    retentionDays: number,
  ) => Promise<AuditRetentionConfig | void> | AuditRetentionConfig | void;
};

type AuditLogFixture = {
  id: string;
  org_id: string;
  created_at: string;
};

type RetentionFixture = {
  org_id: string;
  retention_days: number;
};

type RetentionD1 = {
  db: D1Database;
  state: {
    auditLogs: AuditLogFixture[];
    retentionConfig: Map<string, number>;
    executed: Array<{ query: string; params: unknown[] }>;
  };
};

function normalizeSql(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function createAuditLog(id: string, orgId: string, daysOld: number): AuditLogFixture {
  return {
    id,
    org_id: orgId,
    created_at: daysAgo(daysOld),
  };
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && value.includes("T");
}

function extractCutoff(query: string, params: unknown[]): string | null {
  for (const param of params) {
    if (isIsoTimestamp(param)) {
      return param;
    }
  }

  for (const param of params) {
    if (typeof param === "number" && Number.isFinite(param)) {
      return daysAgo(param);
    }
  }

  const inlineDays = query.match(/-\s*(\d+)\s*days/);
  if (inlineDays?.[1]) {
    return daysAgo(Number.parseInt(inlineDays[1], 10));
  }

  return null;
}

function filterExpiredLogs(
  rows: AuditLogFixture[],
  query: string,
  params: unknown[],
): AuditLogFixture[] {
  const normalized = normalizeSql(query);
  const cutoff = extractCutoff(normalized, params);
  let filtered = [...rows];

  if (/\borg_id\s*=\s*\?/.test(normalized)) {
    const orgId = params.find(
      (param) => typeof param === "string" && !isIsoTimestamp(param) && !String(param).startsWith("aud_"),
    );

    if (typeof orgId === "string") {
      filtered = filtered.filter((row) => row.org_id === orgId);
    }
  }

  if (cutoff) {
    filtered = filtered.filter((row) => row.created_at < cutoff);
  }

  const limitMatch = normalized.match(/\blimit\s+(\d+)\b/);
  if (limitMatch?.[1]) {
    filtered = filtered.slice(0, Number.parseInt(limitMatch[1], 10));
  }

  return filtered;
}

function createRetentionD1({
  logs = [],
  configs = [],
}: {
  logs?: AuditLogFixture[];
  configs?: RetentionFixture[];
} = {}): RetentionD1 {
  const base = mockD1() as D1Database;
  const state = {
    auditLogs: [...logs],
    retentionConfig: new Map(configs.map((config) => [config.org_id, config.retention_days])),
    executed: [] as Array<{ query: string; params: unknown[] }>,
  };
  const meta = {
    changed_db: false,
    changes: 0,
    duration: 0,
    rows_read: 0,
    rows_written: 0,
  };

  const createPreparedStatement = (query: string) => {
    const normalized = normalizeSql(query);

    const executeFirst = async (params: unknown[]) => {
      state.executed.push({ query: normalized, params: [...params] });

      if (/\bfrom audit_retention_config\b/.test(normalized)) {
        const orgId = params.find((param) => typeof param === "string");
        if (typeof orgId !== "string") {
          return null;
        }

        const retentionDays = state.retentionConfig.get(orgId);
        if (retentionDays === undefined) {
          return null;
        }

        return {
          org_id: orgId,
          orgId,
          retention_days: retentionDays,
          retentionDays,
        };
      }

      if (/\bcount\s*\(\s*\*\s*\)/.test(normalized) && /\bfrom audit_logs\b/.test(normalized)) {
        const count = filterExpiredLogs(state.auditLogs, normalized, params).length;
        return {
          count,
          expiredCount: count,
          deletedCount: count,
        };
      }

      if (/\bselect\b/.test(normalized) && /\bfrom audit_logs\b/.test(normalized)) {
        return filterExpiredLogs(state.auditLogs, normalized, params)[0] ?? null;
      }

      return null;
    };

    const executeAll = async (params: unknown[]) => {
      state.executed.push({ query: normalized, params: [...params] });

      if (/\bselect\b/.test(normalized) && /\bfrom audit_logs\b/.test(normalized)) {
        return filterExpiredLogs(state.auditLogs, normalized, params);
      }

      return [];
    };

    const executeRun = async (params: unknown[]) => {
      state.executed.push({ query: normalized, params: [...params] });

      if (
        /\b(insert|replace)\b/.test(normalized) &&
        /\binto audit_retention_config\b/.test(normalized)
      ) {
        const [orgId, retentionDays] = params;
        if (typeof orgId === "string" && typeof retentionDays === "number") {
          state.retentionConfig.set(orgId, retentionDays);
        }

        return {
          success: true,
          meta: {
            ...meta,
            changes: 1,
            rows_written: 1,
          },
        };
      }

      if (
        /\bupdate audit_retention_config\b/.test(normalized) &&
        /\bwhere org_id\s*=\s*\?/.test(normalized)
      ) {
        const [retentionDays, orgId] = params;
        if (typeof orgId === "string" && typeof retentionDays === "number") {
          state.retentionConfig.set(orgId, retentionDays);
        }

        return {
          success: true,
          meta: {
            ...meta,
            changes: 1,
            rows_written: 1,
          },
        };
      }

      if (/\bdelete\s+from audit_logs\b/.test(normalized)) {
        const toDelete = new Set(filterExpiredLogs(state.auditLogs, normalized, params).map((row) => row.id));
        const before = state.auditLogs.length;
        state.auditLogs = state.auditLogs.filter((row) => !toDelete.has(row.id));
        const changes = before - state.auditLogs.length;

        return {
          success: true,
          meta: {
            ...meta,
            changes,
            rows_written: changes,
          },
        };
      }

      return {
        success: true,
        meta,
      };
    };

    return {
      bind: (...params: unknown[]) =>
        ({
          first: async <T>() => (await executeFirst(params)) as T | null,
          all: async <T>() => ({
            results: (await executeAll(params)) as T[],
            success: true,
            meta,
          }),
          raw: async <T>() => (await executeAll(params)) as T[],
          run: async () => executeRun(params),
        }) as D1PreparedStatement,
      first: async <T>() => (await executeFirst([])) as T | null,
      all: async <T>() => ({
        results: (await executeAll([])) as T[],
        success: true,
        meta,
      }),
      raw: async <T>() => (await executeAll([])) as T[],
      run: async () => executeRun([]),
    };
  };

  return {
    db: {
      ...base,
      prepare: (query: string) => createPreparedStatement(query) as D1PreparedStatement,
    } as D1Database,
    state,
  };
}

async function loadAuditRetention(): Promise<AuditRetentionModule> {
  let moduleRecord: Record<string, unknown>;

  try {
    moduleRecord = (await import("../engine/audit-retention.js")) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    assert.fail(`Expected audit retention module at ../engine/audit-retention.js: ${message}`);
  }

  assert.equal(
    typeof moduleRecord.purgeExpiredEntries,
    "function",
    "audit retention module should export purgeExpiredEntries()",
  );
  assert.equal(
    typeof moduleRecord.countExpiredEntries,
    "function",
    "audit retention module should export countExpiredEntries()",
  );
  assert.equal(
    typeof moduleRecord.getRetentionConfig,
    "function",
    "audit retention module should export getRetentionConfig()",
  );
  assert.equal(
    typeof moduleRecord.setRetentionConfig,
    "function",
    "audit retention module should export setRetentionConfig()",
  );

  return moduleRecord as unknown as AuditRetentionModule;
}

function readDeletedCount(result: unknown): number {
  if (typeof result === "number") {
    return result;
  }

  if (
    result &&
    typeof result === "object" &&
    "deletedCount" in result &&
    typeof (result as { deletedCount?: unknown }).deletedCount === "number"
  ) {
    return (result as { deletedCount: number }).deletedCount;
  }

  assert.fail("purgeExpiredEntries() should return a deleted row count");
}

function readExpiredCount(result: unknown): number {
  if (typeof result === "number") {
    return result;
  }

  if (
    result &&
    typeof result === "object" &&
    "expiredCount" in result &&
    typeof (result as { expiredCount?: unknown }).expiredCount === "number"
  ) {
    return (result as { expiredCount: number }).expiredCount;
  }

  if (
    result &&
    typeof result === "object" &&
    "count" in result &&
    typeof (result as { count?: unknown }).count === "number"
  ) {
    return (result as { count: number }).count;
  }

  assert.fail("countExpiredEntries() should return an expired row count");
}

function assertRetentionConfig(
  value: unknown,
  expectedOrgId: string,
  expectedRetentionDays: number,
): void {
  assert.ok(value && typeof value === "object", "expected a retention config object");
  assert.equal((value as { orgId?: unknown }).orgId, expectedOrgId);
  assert.equal((value as { retentionDays?: unknown }).retentionDays, expectedRetentionDays);
}

test("purgeExpiredEntries deletes entries older than the provided retentionDays", async () => {
  const retention = await loadAuditRetention();
  const { db, state } = createRetentionD1({
    logs: [
      createAuditLog("aud_expired_120", "org_test", 120),
      createAuditLog("aud_expired_95", "org_test", 95),
      createAuditLog("aud_recent_10", "org_test", 10),
    ],
  });

  await retention.purgeExpiredEntries(db, 90);

  assert.deepEqual(
    state.auditLogs.map((row) => row.id).sort(),
    ["aud_recent_10"],
  );
});

test("default retention is 90 days", async () => {
  const retention = await loadAuditRetention();
  const { db } = createRetentionD1({
    logs: [
      createAuditLog("aud_expired_120", "org_default", 120),
      createAuditLog("aud_recent_30", "org_default", 30),
    ],
  });

  const expiredCount = readExpiredCount(await retention.countExpiredEntries(db));
  assert.equal(expiredCount, 1);
});

test("per-org retention override is respected", async () => {
  const retention = await loadAuditRetention();
  const { db } = createRetentionD1({
    configs: [{ org_id: "org_override", retention_days: 30 }],
  });

  const override = await retention.getRetentionConfig(db, "org_override");
  const fallback = await retention.getRetentionConfig(db, "org_default");

  assertRetentionConfig(override, "org_override", 30);
  assertRetentionConfig(fallback, "org_default", 90);
});

test("purgeExpiredEntries returns count of deleted entries", async () => {
  const retention = await loadAuditRetention();
  const { db, state } = createRetentionD1({
    logs: [
      createAuditLog("aud_expired_130", "org_test", 130),
      createAuditLog("aud_expired_100", "org_test", 100),
      createAuditLog("aud_recent_5", "org_test", 5),
    ],
  });

  const deletedCount = readDeletedCount(await retention.purgeExpiredEntries(db, 90));

  assert.equal(deletedCount, 2);
  assert.equal(state.auditLogs.length, 1);
});

test("getRetentionConfig returns org-specific or default config", async () => {
  const retention = await loadAuditRetention();
  const { db } = createRetentionD1({
    configs: [{ org_id: "org_custom", retention_days: 120 }],
  });

  assertRetentionConfig(await retention.getRetentionConfig(db, "org_custom"), "org_custom", 120);
  assertRetentionConfig(await retention.getRetentionConfig(db, "org_fallback"), "org_fallback", 90);
});

test("setRetentionConfig updates org retention setting", async () => {
  const retention = await loadAuditRetention();
  const { db } = createRetentionD1({
    configs: [{ org_id: "org_test", retention_days: 30 }],
  });

  await retention.setRetentionConfig(db, "org_test", 180);

  assertRetentionConfig(await retention.getRetentionConfig(db, "org_test"), "org_test", 180);
});

test("retention minimum is 7 days and lower values are rejected", async () => {
  const retention = await loadAuditRetention();
  const { db } = createRetentionD1();

  await assert.rejects(
    async () => retention.setRetentionConfig(db, "org_test", 6),
    /7|minimum|retention/i,
  );
});

test("countExpiredEntries returns the expired count without deleting rows", async () => {
  const retention = await loadAuditRetention();
  const { db, state } = createRetentionD1({
    logs: [
      createAuditLog("aud_expired_100", "org_test", 100),
      createAuditLog("aud_expired_91", "org_test", 91),
      createAuditLog("aud_recent_1", "org_test", 1),
    ],
  });

  const expiredCount = readExpiredCount(await retention.countExpiredEntries(db, 90));

  assert.equal(expiredCount, 2);
  assert.deepEqual(
    state.auditLogs.map((row) => row.id).sort(),
    ["aud_expired_100", "aud_expired_91", "aud_recent_1"],
  );
});
