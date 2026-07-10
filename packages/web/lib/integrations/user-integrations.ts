import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { preserveProviderReadiness } from "@cloud/core/provider-readiness.js";
import { getDb } from "../db";
import { userIntegrations } from "../db/schema";

export type UserIntegrationRecord = {
  userId: string;
  provider: string;
  name?: string | null;
  connectionId: string;
  providerConfigKey: string | null;
  installationId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mapRecord(record: typeof userIntegrations.$inferSelect): UserIntegrationRecord {
  return {
    userId: record.userId,
    provider: record.provider,
    name: record.name ?? null,
    connectionId: record.connectionId,
    providerConfigKey: record.providerConfigKey ?? null,
    installationId: record.installationId ?? null,
    metadata: isRecord(record.metadataJson) ? record.metadataJson : {},
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export async function getUserIntegration(
  userId: string,
  provider: string,
  name: string | null = null,
): Promise<UserIntegrationRecord | null> {
  const db = getDb();
  const [record] = await db
    .select()
    .from(userIntegrations)
    .where(
      and(
        eq(userIntegrations.userId, userId),
        eq(userIntegrations.provider, provider),
        name === null
          ? isNull(userIntegrations.name)
          : eq(userIntegrations.name, name),
      ),
    )
    .limit(1);
  return record ? mapRecord(record) : null;
}

export async function listUserIntegrations(
  userId: string,
): Promise<UserIntegrationRecord[]> {
  const db = getDb();
  const records = await db
    .select()
    .from(userIntegrations)
    .where(eq(userIntegrations.userId, userId))
    .orderBy(asc(userIntegrations.provider));
  return records.map(mapRecord);
}

export async function findUserIntegrationByConnection(
  provider: string,
  connectionId: string,
): Promise<UserIntegrationRecord | null> {
  const db = getDb();
  const [record] = await db
    .select()
    .from(userIntegrations)
    .where(
      and(
        eq(userIntegrations.provider, provider),
        eq(userIntegrations.connectionId, connectionId),
      ),
    )
    .limit(1);
  return record ? mapRecord(record) : null;
}

export async function deleteUserIntegration(
  userId: string,
  provider: string,
  name: string | null = null,
): Promise<void> {
  const db = getDb();
  await db
    .delete(userIntegrations)
    .where(
      and(
        eq(userIntegrations.userId, userId),
        eq(userIntegrations.provider, provider),
        name === null
          ? isNull(userIntegrations.name)
          : eq(userIntegrations.name, name),
      ),
    );
}

export type UpsertUserIntegrationInput = {
  userId: string;
  provider: string;
  name?: string | null;
  connectionId: string;
  providerConfigKey?: string | null;
  installationId?: string | null;
  metadata?: Record<string, unknown>;
};

export async function insertUserIntegrationIfAbsent(
  input: UpsertUserIntegrationInput,
): Promise<{ inserted: boolean; existing?: UserIntegrationRecord }> {
  const db = getDb();
  const timestamp = new Date();
  const metadata = input.metadata ?? {};

  const inserted = await db
    .insert(userIntegrations)
    .values({
      userId: input.userId,
      provider: input.provider,
      name: input.name ?? null,
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey ?? null,
      installationId: input.installationId ?? null,
      metadataJson: metadata,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoNothing(
      input.name
        ? {
          target: [
            userIntegrations.userId,
            userIntegrations.provider,
            userIntegrations.name,
          ],
          where: sql`${userIntegrations.name} IS NOT NULL`,
        }
        : {
          target: [userIntegrations.userId, userIntegrations.provider],
          where: sql`${userIntegrations.name} IS NULL`,
        },
    )
    .returning();

  if (inserted.length > 0) {
    return { inserted: true };
  }

  const existing = await getUserIntegration(
    input.userId,
    input.provider,
    input.name ?? null,
  );
  return { inserted: false, existing: existing ?? undefined };
}

export async function upsertUserIntegration(
  input: UpsertUserIntegrationInput,
): Promise<UserIntegrationRecord> {
  const db = getDb();
  const timestamp = new Date();
  const existing = await getUserIntegration(
    input.userId,
    input.provider,
    input.name ?? null,
  );
  const metadata = preserveProviderReadiness(
    existing?.metadata ?? {},
    input.metadata ?? {},
  );

  const [record] = await db
    .insert(userIntegrations)
    .values({
      userId: input.userId,
      provider: input.provider,
      name: input.name ?? null,
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey ?? null,
      installationId: input.installationId ?? null,
      metadataJson: metadata,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate(
      input.name
        ? {
          target: [
            userIntegrations.userId,
            userIntegrations.provider,
            userIntegrations.name,
          ],
          targetWhere: sql`${userIntegrations.name} IS NOT NULL`,
          set: {
            connectionId: input.connectionId,
            providerConfigKey: input.providerConfigKey ?? null,
            installationId: input.installationId ?? null,
            metadataJson: metadata,
            updatedAt: timestamp,
          },
        }
        : {
          target: [userIntegrations.userId, userIntegrations.provider],
          targetWhere: sql`${userIntegrations.name} IS NULL`,
          set: {
            connectionId: input.connectionId,
            providerConfigKey: input.providerConfigKey ?? null,
            installationId: input.installationId ?? null,
            metadataJson: metadata,
            updatedAt: timestamp,
          },
        },
    )
    .returning();

  return mapRecord(record);
}
