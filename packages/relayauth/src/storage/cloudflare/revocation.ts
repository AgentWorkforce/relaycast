import type { RevocationStorage } from "@relayauth/server/storage/interface";
import { StorageError } from "@relayauth/server/storage/interface";
import type { CloudflareStorageBindings } from "./types.js";

type RevocationStorageBindings = Pick<CloudflareStorageBindings, "REVOCATION_KV">;

/**
 * Stores revoked token ids in Cloudflare KV so revocation state is shared across workers.
 */
export class CloudflareRevocationStorage implements RevocationStorage {
  constructor(private readonly bindings: RevocationStorageBindings) {}

  async revokeIdentityTokens(identityId: string, tokenIds: string[], revokedAt: string): Promise<void> {
    const normalizedIdentityId = normalizeRequiredString(identityId, "identityId is required");
    const normalizedTokenIds = normalizeStringArray(tokenIds);
    if (normalizedTokenIds.length === 0) {
      return;
    }

    const normalizedRevokedAt = normalizeRequiredString(revokedAt, "revokedAt is required");
    await Promise.all(
      normalizedTokenIds.map((tokenId) =>
        this.bindings.REVOCATION_KV.put(
          toRevocationKey(tokenId),
          JSON.stringify({
            tokenId,
            identityId: normalizedIdentityId,
            revokedAt: normalizedRevokedAt,
          }),
        ),
      ),
    );
  }

  async isRevoked(tokenId: string): Promise<boolean> {
    const normalizedTokenId = normalizeOptionalString(tokenId);
    if (!normalizedTokenId) {
      return false;
    }

    const value = await this.bindings.REVOCATION_KV.get(toRevocationKey(normalizedTokenId));
    return typeof value === "string" && value.length > 0;
  }

  // @relayauth/server's token routes call `revocations.revoke(jti, expiresAt)`
  // to write a per-JTI revocation entry with a bounded TTL (refresh-reuse
  // detection, single-token revoke). expiresAt is unix seconds — matches the
  // Node sqlite adapter's requireUnixTimestamp signature. Without this method
  // the server short-circuits past a `typeof … === "function"` guard and
  // Cloudflare silently diverges from Node sqlite semantics.
  async revoke(tokenId: string, expiresAt: number): Promise<void> {
    const normalizedTokenId = normalizeRequiredString(tokenId, "tokenId is required");
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
      throw new StorageError("expiresAt is required", 400, "invalid_storage_input");
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const key = toRevocationKey(normalizedTokenId);
    if (expiresAt <= nowSeconds) {
      await this.bindings.REVOCATION_KV.delete(key);
      return;
    }

    // Cloudflare KV rejects expiration less than 60s in the future.
    const expiration = expiresAt - nowSeconds < 60 ? nowSeconds + 60 : expiresAt;
    await this.bindings.REVOCATION_KV.put(
      key,
      JSON.stringify({ tokenId: normalizedTokenId, revokedAt: new Date().toISOString() }),
      { expiration },
    );
  }
}

function toRevocationKey(tokenId: string): string {
  return `revoked:${tokenId}`;
}

function normalizeRequiredString(value: unknown, message: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new StorageError(message, 400, "invalid_storage_input");
  }

  return normalized;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeStringArray(values: string[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => normalizeOptionalString(value) ?? "")
        .filter((value): value is string => value.length > 0),
    ),
  );
}
