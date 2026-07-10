import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareAuditWebhookStorage } from "../webhooks.js";

type StoredWebhook = {
  id: string;
  orgId: string;
  url: string;
  secret: string;
  events?: string[];
  createdAt: string;
  updatedAt: string;
};

type AuditWebhookRow = {
  id?: string;
  org_id?: string;
  url?: string;
  secret?: string;
  events_json?: string | null;
  created_at?: string;
  updated_at?: string;
};

type RecordedStatement = {
  sql: string;
  params: unknown[];
};

function normalizeSql(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

function createWebhookRecord(overrides: Partial<StoredWebhook> = {}): StoredWebhook {
  const timestamp = overrides.createdAt ?? "2026-03-28T10:00:00.000Z";

  return {
    id: overrides.id ?? "awh_seed_001",
    orgId: overrides.orgId ?? "org_primary",
    url: overrides.url ?? "https://audit.example.com/hooks/primary",
    secret: overrides.secret ?? "whsec_seed_primary",
    events: overrides.events ?? ["scope.denied"],
    createdAt: timestamp,
    updatedAt: overrides.updatedAt ?? timestamp,
  };
}

function toRow(record: StoredWebhook): AuditWebhookRow {
  return {
    id: record.id,
    org_id: record.orgId,
    url: record.url,
    secret: record.secret,
    events_json: JSON.stringify(record.events ?? []),
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

function parseEvents(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parseEvents(parsed);
  } catch {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
}

function createWebhookD1(seed: StoredWebhook[] = []) {
  const records = new Map(seed.map((record) => [record.id, { ...record }]));
  const statements: RecordedStatement[] = [];
  const meta = {
    changed_db: false,
    changes: 0,
    duration: 0,
    rows_read: 0,
    rows_written: 0,
  };

  const extractFilters = (query: string, params: unknown[]) => {
    const normalized = normalizeSql(query);
    const filters = [
      { key: "orgId", index: normalized.search(/\borg_id\s*=\s*\?/i) },
      { key: "id", index: normalized.search(/\bid\s*=\s*\?/i) },
    ]
      .filter((filter) => filter.index >= 0)
      .sort((left, right) => left.index - right.index);

    const values = new Map<string, unknown>();
    for (let index = 0; index < filters.length; index += 1) {
      values.set(filters[index]?.key ?? "", params[index]);
    }
    return values;
  };

  const selectRows = (query: string, params: unknown[]) => {
    const normalized = normalizeSql(query);
    if (!/\bfrom audit_webhooks\b/.test(normalized)) {
      return [];
    }

    const filters = extractFilters(query, params);
    let results = [...records.values()];

    const orgId = filters.get("orgId");
    if (typeof orgId === "string") {
      results = results.filter((record) => record.orgId === orgId);
    }

    const id = filters.get("id");
    if (typeof id === "string") {
      results = results.filter((record) => record.id === id);
    }

    results.sort(
      (left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    );

    return results.map(toRow);
  };

  const deleteRows = (query: string, params: unknown[]) => {
    const filters = extractFilters(query, params);
    let deleted = 0;

    for (const [id, record] of records.entries()) {
      if (typeof filters.get("orgId") === "string" && record.orgId !== filters.get("orgId")) {
        continue;
      }

      if (typeof filters.get("id") === "string" && record.id !== filters.get("id")) {
        continue;
      }

      records.delete(id);
      deleted += 1;
    }

    return deleted;
  };

  const insertRow = (params: unknown[]) => {
    const record: StoredWebhook = {
      id: String(params[0]),
      orgId: String(params[1]),
      url: String(params[2]),
      secret: String(params[3]),
      events: parseEvents(params[4]) ?? [],
      createdAt: String(params[5]),
      updatedAt: String(params[6]),
    };

    records.set(record.id, record);
    return record;
  };

  const execute = (query: string, params: unknown[]) => {
    statements.push({ sql: query, params: [...params] });
    const normalized = normalizeSql(query);

    if (/\binsert\s+into\s+audit_webhooks\b/.test(normalized)) {
      insertRow(params);
      return [];
    }

    if (/\bdelete\s+from\s+audit_webhooks\b/.test(normalized)) {
      return deleteRows(query, params);
    }

    return selectRows(query, params);
  };

  const createPreparedStatement = (query: string) => ({
    bind: (...params: unknown[]) => ({
      first: async <T>() => {
        const result = execute(query, params);
        return Array.isArray(result) ? ((result[0] as T | null) ?? null) : null;
      },
      raw: async <T>() => {
        const result = execute(query, params);
        return (Array.isArray(result) ? result : []) as T[];
      },
      all: async <T>() => {
        const result = execute(query, params);
        return {
          results: (Array.isArray(result) ? result : []) as T[],
          success: true,
          meta,
        };
      },
      run: async () => {
        const result = execute(query, params);
        const changes = typeof result === "number" ? result : /\binsert\s+into\b/.test(normalizeSql(query)) ? 1 : 0;
        return {
          success: true,
          meta: {
            ...meta,
            changes,
            rows_written: changes,
          },
        };
      },
    }),
    first: async <T>() => (selectRows(query, [])[0] as T | null) ?? null,
    raw: async <T>() => selectRows(query, []) as T[],
    all: async <T>() => ({
      results: selectRows(query, []) as T[],
      success: true,
      meta,
    }),
    run: async () => ({
      success: true,
      meta,
    }),
  });

  return {
    records,
    statements,
    db: {
      prepare: (query: string) => createPreparedStatement(query),
      batch: async <T>(preparedStatements: D1PreparedStatement[]) =>
        Promise.all(preparedStatements.map((statement) => statement.run())) as Awaited<T>,
      dump: async () => new ArrayBuffer(0),
    } as D1Database,
  };
}

describe("CloudflareAuditWebhookStorage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-28T12:34:56.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("create() inserts a webhook and returns its id", async () => {
    const { db, records, statements } = createWebhookD1();
    const storage = new CloudflareAuditWebhookStorage({ DB: db });

    const webhook = await storage.create({
      orgId: "org_create",
      url: "https://audit.example.com/hooks/create",
      secret: "whsec_create",
    });

    expect(webhook.id).toMatch(/^awh_/);
    expect(webhook.orgId).toBe("org_create");
    expect(webhook.url).toBe("https://audit.example.com/hooks/create");
    expect(webhook.secret).toBe("whsec_create");
    expect(webhook.events).toEqual([]);
    expect(webhook.createdAt).toBe("2026-03-28T12:34:56.000Z");
    expect(webhook.updatedAt).toBe("2026-03-28T12:34:56.000Z");
    expect(records.get(webhook.id)).toEqual({
      id: webhook.id,
      orgId: "org_create",
      url: "https://audit.example.com/hooks/create",
      secret: "whsec_create",
      events: [],
      createdAt: "2026-03-28T12:34:56.000Z",
      updatedAt: "2026-03-28T12:34:56.000Z",
    });
    expect(
      statements.find((statement) => /\binsert\s+into\s+audit_webhooks\b/.test(normalizeSql(statement.sql)))
        ?.params,
    ).toEqual([
      webhook.id,
      "org_create",
      "https://audit.example.com/hooks/create",
      "whsec_create",
      "[]",
      "2026-03-28T12:34:56.000Z",
      "2026-03-28T12:34:56.000Z",
    ]);
  });

  it("list() returns all webhooks for an org", async () => {
    const { db } = createWebhookD1([
      createWebhookRecord({
        id: "awh_org_older",
        orgId: "org_list",
        createdAt: "2026-03-28T09:00:00.000Z",
        updatedAt: "2026-03-28T09:00:00.000Z",
      }),
      createWebhookRecord({
        id: "awh_other_org",
        orgId: "org_other",
        createdAt: "2026-03-28T09:30:00.000Z",
        updatedAt: "2026-03-28T09:30:00.000Z",
      }),
      createWebhookRecord({
        id: "awh_org_newer",
        orgId: "org_list",
        createdAt: "2026-03-28T10:00:00.000Z",
        updatedAt: "2026-03-28T10:00:00.000Z",
      }),
    ]);
    const storage = new CloudflareAuditWebhookStorage({ DB: db });

    const webhooks = await storage.list("org_list");

    expect(webhooks.map((webhook) => webhook.id)).toEqual([
      "awh_org_newer",
      "awh_org_older",
    ]);
    expect(webhooks.every((webhook) => webhook.orgId === "org_list")).toBe(true);
  });

  it("delete() removes a webhook by id", async () => {
    const { db, records } = createWebhookD1([
      createWebhookRecord({
        id: "awh_delete_me",
        orgId: "org_delete",
      }),
      createWebhookRecord({
        id: "awh_keep_me",
        orgId: "org_delete",
        createdAt: "2026-03-28T10:05:00.000Z",
        updatedAt: "2026-03-28T10:05:00.000Z",
      }),
    ]);
    const storage = new CloudflareAuditWebhookStorage({ DB: db });

    await storage.delete("org_delete", "awh_delete_me");

    expect(records.has("awh_delete_me")).toBe(false);
    expect(records.has("awh_keep_me")).toBe(true);
  });

  it("create() stores an events filter array", async () => {
    const { db, records, statements } = createWebhookD1();
    const storage = new CloudflareAuditWebhookStorage({ DB: db });

    const webhook = await storage.create({
      orgId: "org_events",
      url: "https://audit.example.com/hooks/events",
      secret: "whsec_events",
      events: ["identity.suspended", "scope.denied"],
    });

    expect(webhook.events).toEqual(["identity.suspended", "scope.denied"]);
    expect(records.get(webhook.id)?.events).toEqual(["identity.suspended", "scope.denied"]);
    expect(
      statements.find((statement) => /\binsert\s+into\s+audit_webhooks\b/.test(normalizeSql(statement.sql)))
        ?.params[4],
    ).toBe("[\"identity.suspended\",\"scope.denied\"]");
  });
});
