import type { SQL } from "drizzle-orm";
import type { PlatformDb } from "./client.js";
import * as schema from "./schema.js";
import type {
  PlatformProduct,
  WorkspacePlatformAccessRecord,
  WorkspacePlatformPolicyRecord,
} from "./schema.js";

type FakePlatformDb = PlatformDb & {
  listProducts: () => PlatformProduct[];
  productCount: () => number;
};

export function createFakePlatformDb(): FakePlatformDb {
  const products = new Map<string, PlatformProduct>();
  const policies = new Map<string, WorkspacePlatformPolicyRecord>();
  const access = new Map<string, WorkspacePlatformAccessRecord>();

  const db = {
    query: {
      workspacePlatformPolicies: {
        findFirst: async ({ where }: { where: SQL }) => {
          const [workspaceId] = getBoundValues(where);
          return workspaceId ? policies.get(workspaceId) ?? undefined : undefined;
        },
      },
    },
    select: (_selection: unknown) => ({
      from: (table: unknown) => {
        assertTable(table, schema.workspacePlatformAccess, "workspace_platform_access");

        return {
          where: (condition: SQL) => {
            const [workspaceId] = getBoundValues(condition);
            const rows = [...access.values()]
              .filter((row) => row.workspaceId === workspaceId)
              .map((row) => ({ productId: row.productId }));

            return {
              orderBy: async () =>
                [...rows].sort((left, right) => left.productId.localeCompare(right.productId)),
            };
          },
        };
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        if (table === schema.platformProducts) {
          return {
            onConflictDoUpdate: (_config: unknown) => ({
              returning: async () => {
                const now = new Date();
                const id = asString(values.id);
                const existing = products.get(id);
                const record: PlatformProduct = existing
                  ? {
                      ...existing,
                      displayName: asString(values.displayName),
                      description: asNullableString(values.description),
                      updatedAt: now,
                    }
                  : {
                      id,
                      displayName: asString(values.displayName),
                      description: asNullableString(values.description),
                      createdAt: now,
                      updatedAt: now,
                    };

                products.set(id, record);
                return [record];
              },
            }),
            onConflictDoNothing: async () => {
              const id = asString(values.id);
              if (!products.has(id)) {
                const now = new Date();
                products.set(id, {
                  id,
                  displayName: asString(values.displayName),
                  description: asNullableString(values.description),
                  createdAt: now,
                  updatedAt: now,
                });
              }
            },
          };
        }

        if (table === schema.workspacePlatformPolicies) {
          return {
            onConflictDoNothing: async () => {
              const workspaceId = asString(values.workspaceId);
              if (!policies.has(workspaceId)) {
                const now = new Date();
                policies.set(workspaceId, {
                  workspaceId,
                  enforceProductScope: Boolean(values.enforceProductScope),
                  createdAt: now,
                  updatedAt: now,
                });
              }
            },
          };
        }

        if (table === schema.workspacePlatformAccess) {
          return {
            onConflictDoNothing: async () => {
              const workspaceId = asString(values.workspaceId);
              const productId = asString(values.productId);
              const key = toAccessKey(workspaceId, productId);
              if (!access.has(key)) {
                access.set(key, {
                  workspaceId,
                  productId,
                  grantedAt: new Date(),
                });
              }
            },
          };
        }

        throw new Error("Unsupported table insert");
      },
    }),
    delete: (table: unknown) => {
      assertTable(table, schema.workspacePlatformAccess, "workspace_platform_access");

      return {
        where: async (condition: SQL) => {
          const [workspaceId, productId] = getBoundValues(condition);
          access.delete(toAccessKey(workspaceId, productId));
        },
      };
    },
    execute: async (statement: SQL) => {
      const query = getSqlText(statement).trim().toLowerCase();

      if (
        query.startsWith("create table if not exists") ||
        query.startsWith("create index if not exists")
      ) {
        return { rows: [] };
      }

      if (query === "select count(*)::int as count from platform_products") {
        return { rows: [{ count: products.size }] };
      }

      throw new Error(`Unsupported SQL statement: ${query}`);
    },
    listProducts: () => [...products.values()],
    productCount: () => products.size,
  };

  return db as unknown as FakePlatformDb;
}

function getBoundValues(statement: SQL): string[] {
  const chunks = (statement as SQL & { queryChunks?: unknown[] }).queryChunks ?? [];

  return chunks.flatMap((chunk) => {
    if (typeof chunk === "string") {
      return [chunk];
    }

    if (chunk && typeof chunk === "object" && "value" in chunk) {
      const value = (chunk as { value?: unknown }).value;
      if (typeof value === "string") {
        return [value];
      }
    }

    return [];
  });
}

function getSqlText(statement: SQL): string {
  const chunks = (statement as SQL & { queryChunks?: unknown[] }).queryChunks ?? [];

  return chunks
    .flatMap((chunk) => {
      if (typeof chunk === "string") {
        return [chunk];
      }

      if (chunk && typeof chunk === "object" && "value" in chunk) {
        const value = (chunk as { value?: unknown }).value;
        if (Array.isArray(value)) {
          return value.filter((part): part is string => typeof part === "string");
        }
      }

      return [];
    })
    .join("");
}

function assertTable(table: unknown, expected: unknown, name: string): void {
  if (table !== expected) {
    throw new Error(`Unsupported table: ${name}`);
  }
}

function asString(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Expected string value");
  }

  return value;
}

function asNullableString(value: unknown): string | null {
  if (value == null) {
    return null;
  }

  return asString(value);
}

function toAccessKey(workspaceId: string, productId: string): string {
  return `${workspaceId}:${productId}`;
}
