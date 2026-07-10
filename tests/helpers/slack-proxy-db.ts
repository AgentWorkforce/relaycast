import { getTableName } from "drizzle-orm";

export type TestWorkspaceRow = {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
};

export type TestWorkspaceIntegrationRow = {
  id: string;
  workspaceId: string;
  provider: string;
  adapter: string;
  name: string | null;
  displayName: string | null;
  createdByUserId: string | null;
  connectionId: string;
  providerConfigKey: string | null;
  installationId: string | null;
  metadataJson: string;
  createdAt: Date;
  updatedAt: Date;
};

type TestWorkspaceDbSeed = {
  workspaces?: TestWorkspaceRow[];
  workspaceIntegrations?: TestWorkspaceIntegrationRow[];
};

type QueryableRow = Record<string, unknown>;

type SqlLike = {
  queryChunks?: unknown[];
};

type ColumnLike = {
  name: string;
};

type ParamLike = {
  value: unknown;
};

const DEFAULT_TIMESTAMP = new Date("2026-04-14T00:00:00.000Z");

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isSqlLike(value: unknown): value is SqlLike {
  return isObject(value) && Array.isArray(value.queryChunks);
}

function isColumnLike(value: unknown): value is ColumnLike {
  return isObject(value) && typeof value.name === "string";
}

function isParamLike(value: unknown): value is ParamLike {
  return isObject(value) && "value" in value;
}

function readStringChunk(value: unknown): string {
  if (!isObject(value) || !Array.isArray(value.value)) {
    return "";
  }

  return value.value.join("");
}

function snakeToCamel(value: string): string {
  return value.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function getRowValue(row: QueryableRow, columnName: string): unknown {
  return row[snakeToCamel(columnName)] ?? row[columnName];
}

function splitSql(sql: SqlLike, separator: "and" | "or"): SqlLike[] {
  const parts: SqlLike[] = [];
  let current: unknown[] = [];

  for (const chunk of sql.queryChunks ?? []) {
    if (readStringChunk(chunk).trim().toLowerCase() === separator) {
      parts.push({ queryChunks: current });
      current = [];
      continue;
    }

    current.push(chunk);
  }

  if (current.length > 0) {
    parts.push({ queryChunks: current });
  }

  return parts;
}

function unwrapSql(sql: SqlLike): SqlLike {
  const chunks = sql.queryChunks ?? [];
  if (chunks.length === 3 && readStringChunk(chunks[0]) === "(" && isSqlLike(chunks[1]) && readStringChunk(chunks[2]) === ")") {
    return unwrapSql(chunks[1]);
  }

  return sql;
}

function toLikeRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = escaped.replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${source}$`);
}

function evaluateComparison(sql: SqlLike, row: QueryableRow): boolean {
  const chunks = (sql.queryChunks ?? []).filter((chunk) => readStringChunk(chunk) !== "");
  const operatorChunk = chunks.find((chunk) => {
    const normalized = readStringChunk(chunk).trim().toLowerCase();
    return normalized === "=" || normalized === "like";
  });

  if (!operatorChunk) {
    return true;
  }

  const operatorIndex = chunks.indexOf(operatorChunk);
  const column = chunks.slice(0, operatorIndex).find(isColumnLike);
  const valueChunk = chunks
    .slice(operatorIndex + 1)
    .find((chunk) => isParamLike(chunk) || typeof chunk === "string");

  if (!column || valueChunk === undefined) {
    return true;
  }

  const actualValue = getRowValue(row, column.name);
  const expectedValue = isParamLike(valueChunk) ? valueChunk.value : valueChunk;
  const operator = readStringChunk(operatorChunk).trim().toLowerCase();

  if (operator === "=") {
    return actualValue === expectedValue;
  }

  if (operator === "like") {
    return toLikeRegExp(String(expectedValue)).test(String(actualValue ?? ""));
  }

  return true;
}

function matchesWhere(sql: unknown, row: QueryableRow): boolean {
  if (!isSqlLike(sql)) {
    return true;
  }

  const normalized = unwrapSql(sql);
  const chunks = normalized.queryChunks ?? [];

  if (chunks.some((chunk) => readStringChunk(chunk).trim().toLowerCase() === "and")) {
    return splitSql(normalized, "and").every((part) => matchesWhere(part, row));
  }

  if (chunks.some((chunk) => readStringChunk(chunk).trim().toLowerCase() === "or")) {
    return splitSql(normalized, "or").some((part) => matchesWhere(part, row));
  }

  if (chunks.some(isSqlLike)) {
    return chunks.filter(isSqlLike).every((part) => matchesWhere(part, row));
  }

  return evaluateComparison(normalized, row);
}

export function createTestWorkspaceDb(seed: TestWorkspaceDbSeed = {}) {
  const state = {
    workspaces: [...(seed.workspaces ?? [])],
    workspaceIntegrations: [...(seed.workspaceIntegrations ?? [])],
  };

  function seedWorkspace(input: Partial<TestWorkspaceRow> & { id: string }): TestWorkspaceRow {
    const row: TestWorkspaceRow = {
      id: input.id,
      organizationId: input.organizationId ?? "org_test_123",
      slug: input.slug ?? "slack-proxy-test",
      name: input.name ?? "Slack Proxy Test",
      createdAt: input.createdAt ?? DEFAULT_TIMESTAMP,
      updatedAt: input.updatedAt ?? DEFAULT_TIMESTAMP,
    };

    state.workspaces.push(row);
    return row;
  }

  function seedSlackIntegration(
    input: Partial<TestWorkspaceIntegrationRow> & {
      workspaceId: string;
      connectionId?: string;
      providerConfigKey?: string | null;
    },
  ): TestWorkspaceIntegrationRow {
    const row: TestWorkspaceIntegrationRow = {
      id: input.id ?? "11111111-1111-4111-8111-111111111111",
      workspaceId: input.workspaceId,
      provider: input.provider ?? "slack",
      adapter: input.adapter ?? "nango",
      name: input.name ?? null,
      displayName: input.displayName ?? null,
      createdByUserId: input.createdByUserId ?? null,
      connectionId: input.connectionId ?? "conn_slack_test_123",
      providerConfigKey: input.providerConfigKey ?? "slack-relay",
      installationId: input.installationId ?? null,
      metadataJson:
        input.metadataJson ??
        JSON.stringify({
          slackTeamId: "T_SLACK_TEST",
          slackBotUserId: "U_SLACK_BOT",
          workspaceName: "Slack Proxy Test",
        }),
      createdAt: input.createdAt ?? DEFAULT_TIMESTAMP,
      updatedAt: input.updatedAt ?? DEFAULT_TIMESTAMP,
    };

    state.workspaceIntegrations.push(row);
    return row;
  }

  function select() {
    let activeTableName: string | null = null;
    let whereClause: unknown = null;

    return {
      from(table: unknown) {
        activeTableName = getTableName(table as never);
        return this;
      },
      where(clause: unknown) {
        whereClause = clause;
        return this;
      },
      async limit(count: number) {
        const rows =
          activeTableName === "workspace_integrations"
            ? state.workspaceIntegrations
            : activeTableName === "workspaces"
            ? state.workspaces
            : [];

        return rows.filter((row) => matchesWhere(whereClause, row)).slice(0, count);
      },
    };
  }

  return {
    select,
    seedWorkspace,
    seedSlackIntegration,
    reset() {
      state.workspaces.length = 0;
      state.workspaceIntegrations.length = 0;
    },
  };
}
