import { describe, expect, it, vi } from "vitest";
import { CloudflareRevocationStorage } from "../revocation.js";

type KvPutCall = {
  key: string;
  value: string;
  options?: KVNamespacePutOptions;
};

function createRecordingKv(initialValues: Record<string, string> = {}): {
  get: ReturnType<typeof vi.fn>;
  kv: KVNamespace;
  put: ReturnType<typeof vi.fn>;
  puts: KvPutCall[];
  deletes: string[];
} {
  const store = new Map(Object.entries(initialValues));
  const puts: KvPutCall[] = [];
  const deletes: string[] = [];

  const get = vi.fn(async (key: string) => store.get(key) ?? null);
  const put = vi.fn(async (key: string, value: string, options?: KVNamespacePutOptions) => {
    puts.push({ key, value, options });
    store.set(key, value);
  });

  return {
    get,
    put,
    puts,
    deletes,
    kv: {
      get,
      put,
      delete: vi.fn(async (key: string) => {
        deletes.push(key);
        store.delete(key);
      }),
      list: vi.fn(async () => ({ keys: [], list_complete: true, cacheStatus: null })),
      getWithMetadata: vi.fn(async (key: string) => ({
        value: store.get(key) ?? null,
        metadata: null,
        cacheStatus: null,
      })),
    } as KVNamespace,
  };
}

describe("CloudflareRevocationStorage", () => {
  it("revoke() calls KV.put with the jti payload used by the current adapter", async () => {
    const { kv, put, puts } = createRecordingKv();
    const storage = new CloudflareRevocationStorage({ REVOCATION_KV: kv });
    const revokedAt = "2026-03-28T00:30:00.000Z";

    await storage.revokeIdentityTokens("identity_123", ["jti_123"], revokedAt);

    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(
      "revoked:jti_123",
      JSON.stringify({
        tokenId: "jti_123",
        identityId: "identity_123",
        revokedAt,
      }),
    );
    expect(puts).toEqual([
      {
        key: "revoked:jti_123",
        value: JSON.stringify({
          tokenId: "jti_123",
          identityId: "identity_123",
          revokedAt,
        }),
      },
    ]);
  });

  it("isRevoked() returns true when KV.get returns a value", async () => {
    const { get, kv } = createRecordingKv({
      "revoked:jti_123": JSON.stringify({
        tokenId: "jti_123",
        identityId: "identity_123",
        revokedAt: "2026-03-28T00:30:00.000Z",
      }),
    });
    const storage = new CloudflareRevocationStorage({ REVOCATION_KV: kv });

    await expect(storage.isRevoked("jti_123")).resolves.toBe(true);
    expect(get).toHaveBeenCalledWith("revoked:jti_123");
  });

  it("isRevoked() returns false when KV.get returns null", async () => {
    const { get, kv } = createRecordingKv();
    const storage = new CloudflareRevocationStorage({ REVOCATION_KV: kv });

    await expect(storage.isRevoked("jti_missing")).resolves.toBe(false);
    expect(get).toHaveBeenCalledWith("revoked:jti_missing");
  });

  it("revoke() writes a per-jti KV entry with expiration matching expiresAt", async () => {
    const { kv, puts } = createRecordingKv();
    const storage = new CloudflareRevocationStorage({ REVOCATION_KV: kv });

    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiresAt = nowSeconds + 3600;

    await storage.revoke("jti_123", expiresAt);

    expect(puts).toHaveLength(1);
    expect(puts[0].key).toBe("revoked:jti_123");
    expect(puts[0].options?.expiration).toBe(expiresAt);
    const payload = JSON.parse(puts[0].value);
    expect(payload.tokenId).toBe("jti_123");
    expect(typeof payload.revokedAt).toBe("string");
  });

  it("revoke() clamps expiration to the KV 60s minimum when ttl is shorter", async () => {
    const { kv, puts } = createRecordingKv();
    const storage = new CloudflareRevocationStorage({ REVOCATION_KV: kv });

    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiresAt = nowSeconds + 5;

    await storage.revoke("jti_soon", expiresAt);

    expect(puts).toHaveLength(1);
    expect(puts[0].options?.expiration).toBeGreaterThanOrEqual(nowSeconds + 60);
  });

  it("revoke() deletes the KV entry when expiresAt is already in the past", async () => {
    const { kv, puts, deletes } = createRecordingKv({
      "revoked:jti_old": JSON.stringify({ tokenId: "jti_old" }),
    });
    const storage = new CloudflareRevocationStorage({ REVOCATION_KV: kv });

    const expired = Math.floor(Date.now() / 1000) - 10;
    await storage.revoke("jti_old", expired);

    expect(puts).toHaveLength(0);
    expect(deletes).toEqual(["revoked:jti_old"]);
  });
});
