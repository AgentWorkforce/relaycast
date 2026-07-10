import crypto from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db";
import { apiTokenSessions } from "../db/schema";
import type { ApiTokenSubjectType } from "./api-token-types";
import { readBearerToken } from "./bearer";

export type { ApiTokenSubjectType };
export { readBearerToken };

export interface ApiTokenSessionRecord {
  id: string;
  tokenFamilyId: string;
  subjectType: ApiTokenSubjectType;
  userId: string;
  workspaceId: string;
  organizationId: string;
  sandboxId: string | null;
  runId: string | null;
  scopes: string[];
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
  lastRefreshedAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string | null;
}

export interface IssuedApiTokenPair {
  sessionId: string;
  tokenFamilyId: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  subjectType: ApiTokenSubjectType;
  scopes: string[];
}

export interface CreateApiTokenSessionInput {
  subjectType: ApiTokenSubjectType;
  userId: string;
  workspaceId: string;
  organizationId: string;
  sandboxId?: string;
  runId?: string;
  scopes: string[];
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
}

const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 60 * 30;
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
export const OPERATOR_API_ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24;
export const OPERATOR_API_REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 90;
// Long-lived, non-rotating credential for unattended CI deploys. The CLI's
// env-var auth path (WORKFORCE_WORKSPACE_TOKEN) presents the access token
// directly and never refreshes, so the access TTL is the real lifetime.
export const CI_DEPLOY_API_ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 365;
export const CI_DEPLOY_API_REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 365;

function now(): Date {
  return new Date();
}

function dateAt(offsetSeconds: number, fromDate: Date): Date {
  return new Date(fromDate.getTime() + offsetSeconds * 1000);
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function generateOpaqueToken(prefix: string): string {
  return `${prefix}${crypto.randomBytes(32).toString("base64url")}`;
}

function serializeScopes(scopes: string[]): string {
  return JSON.stringify([...new Set(scopes)].sort());
}

function parseScopes(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function isOperatorCliSession(input: {
  subjectType: string;
  scopes: string[] | string;
}): boolean {
  const scopes = Array.isArray(input.scopes) ? input.scopes : parseScopes(input.scopes);
  return input.subjectType === "cli" && scopes.includes("cli:auth");
}

function accessTokenTtlSecondsForRefresh(record: typeof apiTokenSessions.$inferSelect): number {
  return isOperatorCliSession(record)
    ? OPERATOR_API_ACCESS_TOKEN_TTL_SECONDS
    : DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
}

function refreshTokenTtlSecondsForRefresh(record: typeof apiTokenSessions.$inferSelect): number {
  return isOperatorCliSession(record)
    ? OPERATOR_API_REFRESH_TOKEN_TTL_SECONDS
    : DEFAULT_REFRESH_TOKEN_TTL_SECONDS;
}

function mapRecord(record: typeof apiTokenSessions.$inferSelect): ApiTokenSessionRecord {
  return {
    id: record.id,
    tokenFamilyId: record.tokenFamilyId,
    subjectType: record.subjectType as ApiTokenSubjectType,
    userId: record.userId,
    workspaceId: record.workspaceId,
    organizationId: record.organizationId,
    sandboxId: record.sandboxId ?? null,
    runId: record.runId ?? null,
    scopes: parseScopes(record.scopes),
    accessTokenExpiresAt: record.accessTokenExpiresAt,
    refreshTokenExpiresAt: record.refreshTokenExpiresAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastUsedAt: record.lastUsedAt ?? null,
    lastRefreshedAt: record.lastRefreshedAt ?? null,
    revokedAt: record.revokedAt ?? null,
    revokedReason: record.revokedReason ?? null,
  };
}

function isExpired(expiresAt: Date, currentTime: Date): boolean {
  return expiresAt.getTime() <= currentTime.getTime();
}

export async function createApiTokenSession(
  input: CreateApiTokenSessionInput,
): Promise<IssuedApiTokenPair> {
  const db = getDb();
  const createdAt = now();
  const accessToken = generateOpaqueToken("cld_at_");
  const refreshToken = generateOpaqueToken("cld_rt_");
  const accessTokenExpiresAt = dateAt(
    input.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
    createdAt,
  );
  const refreshTokenExpiresAt = dateAt(
    input.refreshTokenTtlSeconds ?? DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
    createdAt,
  );
  const sessionId = crypto.randomUUID();
  const tokenFamilyId = crypto.randomUUID();
  const scopes = [...new Set(input.scopes)];

  await db.insert(apiTokenSessions).values({
    id: sessionId,
    tokenFamilyId,
    subjectType: input.subjectType,
    userId: input.userId,
    workspaceId: input.workspaceId,
    organizationId: input.organizationId,
    sandboxId: input.sandboxId ?? null,
    runId: input.runId ?? null,
    scopes: serializeScopes(scopes),
    accessTokenHash: hashToken(accessToken),
    accessTokenExpiresAt,
    refreshTokenHash: hashToken(refreshToken),
    refreshTokenExpiresAt,
    createdAt,
    updatedAt: createdAt,
  });

  return {
    sessionId,
    tokenFamilyId,
    accessToken,
    accessTokenExpiresAt: accessTokenExpiresAt.toISOString(),
    refreshToken,
    refreshTokenExpiresAt: refreshTokenExpiresAt.toISOString(),
    subjectType: input.subjectType,
    scopes,
  };
}

export async function resolveApiTokenSession(
  accessToken: string,
): Promise<ApiTokenSessionRecord | null> {
  const db = getDb();
  const tokenHash = hashToken(accessToken);
  const [record] = await db
    .select()
    .from(apiTokenSessions)
    .where(and(eq(apiTokenSessions.accessTokenHash, tokenHash), isNull(apiTokenSessions.revokedAt)))
    .limit(1);

  if (!record) {
    return null;
  }

  const currentTime = now();
  if (isExpired(record.accessTokenExpiresAt, currentTime)) {
    return null;
  }

  const lastUsedAt = currentTime;
  await db
    .update(apiTokenSessions)
    .set({
      lastUsedAt,
      updatedAt: lastUsedAt,
    })
    .where(eq(apiTokenSessions.id, record.id));

  return mapRecord({ ...record, lastUsedAt, updatedAt: lastUsedAt });
}

export const resolveApiToken = resolveApiTokenSession;

export async function refreshApiTokenSession(
  refreshToken: string,
): Promise<IssuedApiTokenPair | null> {
  const db = getDb();
  const tokenHash = hashToken(refreshToken);
  const [record] = await db
    .select()
    .from(apiTokenSessions)
    .where(and(eq(apiTokenSessions.refreshTokenHash, tokenHash), isNull(apiTokenSessions.revokedAt)))
    .limit(1);

  if (!record) {
    return null;
  }

  const currentTime = now();
  if (isExpired(record.refreshTokenExpiresAt, currentTime)) {
    await revokeApiTokenSessionById(record.id, "refresh_token_expired");
    return null;
  }

  const nextAccessToken = generateOpaqueToken("cld_at_");
  const nextRefreshToken = generateOpaqueToken("cld_rt_");
  const updatedAt = currentTime;
  const accessTokenExpiresAt = dateAt(accessTokenTtlSecondsForRefresh(record), currentTime);
  const refreshTokenExpiresAt = dateAt(refreshTokenTtlSecondsForRefresh(record), currentTime);

  await db
    .update(apiTokenSessions)
    .set({
      accessTokenHash: hashToken(nextAccessToken),
      accessTokenExpiresAt,
      refreshTokenHash: hashToken(nextRefreshToken),
      refreshTokenExpiresAt,
      lastRefreshedAt: updatedAt,
      updatedAt,
    })
    .where(eq(apiTokenSessions.id, record.id));

  return {
    sessionId: record.id,
    tokenFamilyId: record.tokenFamilyId,
    accessToken: nextAccessToken,
    accessTokenExpiresAt: accessTokenExpiresAt.toISOString(),
    refreshToken: nextRefreshToken,
    refreshTokenExpiresAt: refreshTokenExpiresAt.toISOString(),
    subjectType: record.subjectType as ApiTokenSubjectType,
    scopes: parseScopes(record.scopes),
  };
}

export async function revokeApiTokenSessionById(id: string, reason: string): Promise<void> {
  const db = getDb();
  const timestamp = now();
  await db
    .update(apiTokenSessions)
    .set({
      revokedAt: timestamp,
      revokedReason: reason,
      updatedAt: timestamp,
    })
    .where(eq(apiTokenSessions.id, id));
}

export async function revokeApiTokenSessionByRefreshToken(
  refreshToken: string,
  reason: string,
): Promise<boolean> {
  const db = getDb();
  const tokenHash = hashToken(refreshToken);
  const [record] = await db
    .select({ id: apiTokenSessions.id })
    .from(apiTokenSessions)
    .where(and(eq(apiTokenSessions.refreshTokenHash, tokenHash), isNull(apiTokenSessions.revokedAt)))
    .limit(1);

  if (!record) {
    return false;
  }

  await revokeApiTokenSessionById(record.id, reason);
  return true;
}

export async function revokeApiTokenSessionByAccessToken(
  accessToken: string,
  reason: string,
): Promise<boolean> {
  const db = getDb();
  const tokenHash = hashToken(accessToken);
  const [record] = await db
    .select({ id: apiTokenSessions.id })
    .from(apiTokenSessions)
    .where(and(eq(apiTokenSessions.accessTokenHash, tokenHash), isNull(apiTokenSessions.revokedAt)))
    .limit(1);

  if (!record) {
    return false;
  }

  await revokeApiTokenSessionById(record.id, reason);
  return true;
}

export async function attachSandboxToApiTokenSession(
  sessionId: string,
  sandboxId: string,
): Promise<void> {
  const db = getDb();
  const timestamp = now();
  await db
    .update(apiTokenSessions)
    .set({
      sandboxId,
      updatedAt: timestamp,
    })
    .where(eq(apiTokenSessions.id, sessionId));
}

export async function revokeApiTokenSessionsForRun(runId: string, reason: string): Promise<void> {
  const db = getDb();
  const timestamp = now();
  await db
    .update(apiTokenSessions)
    .set({
      revokedAt: timestamp,
      revokedReason: reason,
      updatedAt: timestamp,
    })
    .where(and(eq(apiTokenSessions.runId, runId), isNull(apiTokenSessions.revokedAt)));
}

export async function revokeApiTokenSessionByAnyToken(
  token: string,
  reason: string,
): Promise<boolean> {
  const accessRevoked = await revokeApiTokenSessionByAccessToken(token, reason);
  if (accessRevoked) {
    return true;
  }

  return revokeApiTokenSessionByRefreshToken(token, reason);
}

export async function revokeApiTokenSession(token: string, reason: string): Promise<boolean> {
  return revokeApiTokenSessionByAnyToken(token, reason);
}
