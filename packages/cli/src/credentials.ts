import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CloudApiClient } from "@cloud/core/auth/api-token-client.js";

export type StoredCredentials = {
  version: 1;
  apiUrl: string;
  updatedAt: string;
  cookieHeader?: string;
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  tokenType?: string;
};

export type TokenSnapshot = {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt?: string;
};

type StoredTokenFields = {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt?: string;
};

const DEFAULT_API_URL = "http://localhost:3000/cloud";

export function resolveCredentialsPath(): string {
  return path.join(os.homedir(), ".cloud", "credentials.json");
}

export function resolveApiUrl(
  explicitApiUrl?: string,
  credentials?: StoredCredentials | null,
): string {
  const resolved =
    explicitApiUrl?.trim() ||
    credentials?.apiUrl?.trim() ||
    process.env.CLOUD_API_URL?.trim() ||
    DEFAULT_API_URL;

  if (resolved.startsWith("http://") && !resolved.includes("localhost") && !resolved.includes("127.0.0.1")) {
    console.warn(`[credentials] WARNING: API URL uses plain HTTP (${resolved}). Credentials may be sent unencrypted.`);
  }

  return resolved;
}

export async function loadCredentials(): Promise<StoredCredentials | null> {
  try {
    const raw = await fs.readFile(resolveCredentialsPath(), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    if (typeof parsed.apiUrl !== "string" || typeof parsed.updatedAt !== "string") {
      return null;
    }

    return {
      version: 1,
      apiUrl: parsed.apiUrl,
      updatedAt: parsed.updatedAt,
      ...(typeof parsed.cookieHeader === "string" ? { cookieHeader: parsed.cookieHeader } : {}),
      ...(typeof parsed.accessToken === "string" ? { accessToken: parsed.accessToken } : {}),
      ...(typeof parsed.refreshToken === "string" ? { refreshToken: parsed.refreshToken } : {}),
      ...(typeof parsed.accessTokenExpiresAt === "string"
        ? { accessTokenExpiresAt: parsed.accessTokenExpiresAt }
        : {}),
      ...(typeof parsed.refreshTokenExpiresAt === "string"
        ? { refreshTokenExpiresAt: parsed.refreshTokenExpiresAt }
        : {}),
      ...(typeof parsed.tokenType === "string" ? { tokenType: parsed.tokenType } : {}),
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw new Error(`Failed to read credentials: ${formatError(error)}`);
  }
}

export async function saveCredentials(credentials: StoredCredentials): Promise<void> {
  const credentialsPath = resolveCredentialsPath();

  await fs.mkdir(path.dirname(credentialsPath), { recursive: true });
  await fs.writeFile(credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.chmod(credentialsPath, 0o600).catch(() => undefined);
}

export async function clearCredentials(): Promise<void> {
  try {
    await fs.rm(resolveCredentialsPath());
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw new Error(`Failed to clear credentials: ${formatError(error)}`);
    }
  }
}

export function hasStoredTokens(credentials: StoredCredentials): boolean {
  return Boolean(
    credentials.accessToken &&
      credentials.refreshToken &&
      credentials.accessTokenExpiresAt,
  );
}

function requireStoredTokens(credentials: StoredCredentials): StoredTokenFields {
  const { accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt } = credentials;

  if (!accessToken || !refreshToken || !accessTokenExpiresAt) {
    throw new Error("Missing Cloud API tokens. Run `cloud login` again.");
  }

  return {
    accessToken,
    refreshToken,
    accessTokenExpiresAt,
    refreshTokenExpiresAt,
  };
}

export function createCloudApiClient(credentials: StoredCredentials): CloudApiClient {
  const tokenFields = requireStoredTokens(credentials);

  return new CloudApiClient({
    apiUrl: credentials.apiUrl,
    accessToken: tokenFields.accessToken,
    refreshToken: tokenFields.refreshToken,
    accessTokenExpiresAt: tokenFields.accessTokenExpiresAt,
    refreshTokenExpiresAt: tokenFields.refreshTokenExpiresAt,
  });
}

export function mergeTokenSnapshot(
  credentials: StoredCredentials,
  snapshot: TokenSnapshot,
): StoredCredentials {
  return {
    ...credentials,
    accessToken: snapshot.accessToken,
    refreshToken: snapshot.refreshToken,
    accessTokenExpiresAt: snapshot.accessTokenExpiresAt,
    refreshTokenExpiresAt: snapshot.refreshTokenExpiresAt,
    updatedAt: new Date().toISOString(),
  };
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
