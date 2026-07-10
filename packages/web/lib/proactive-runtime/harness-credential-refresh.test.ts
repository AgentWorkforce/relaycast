import { describe, expect, it, vi } from "vitest";

import {
  refreshHarnessCliCredentialIfStale,
  HarnessCredentialExpiredError,
  HARNESS_CREDENTIAL_REFRESH_SKEW_MS,
} from "./harness-credential-refresh";

/** Build an unsigned JWT whose `exp` claim is `at` — enough for
 *  parseCredentialExpiry's strategy-1 decode. */
function jwtExpiringAt(at: Date): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(at.getTime() / 1000) }))
    .toString("base64url");
  return `eyJhbGciOiJub25lIn0.${payload}.sig`;
}

function codexCredential(expiresAt: Date): string {
  return JSON.stringify({ tokens: { access_token: jwtExpiringAt(expiresAt) } });
}

const HOUR = 60 * 60 * 1000;

function fakeStore(overrides: Partial<{
  retrieve: (userId: string, provider: string) => Promise<string | null>;
  store: (userId: string, provider: string, credentialJson: string) => Promise<void>;
}> = {}) {
  return {
    retrieve: overrides.retrieve ?? vi.fn(async () => null),
    store: overrides.store ?? vi.fn(async () => undefined),
  };
}

describe("refreshHarnessCliCredentialIfStale", () => {
  it("refreshes and persists an expired credential before mounting", async () => {
    const stale = codexCredential(new Date(Date.now() - HOUR));
    const freshJson = codexCredential(new Date(Date.now() + 8 * HOUR));
    const store = fakeStore();
    const refresh = vi.fn(async () => ({ credentialJson: freshJson, expiresAt: null }));

    const result = await refreshHarnessCliCredentialIfStale({
      store,
      userId: "user-1",
      provider: "openai",
      credentialJson: stale,
      refresh,
    });

    expect(refresh).toHaveBeenCalledWith("openai", stale);
    expect(store.store).toHaveBeenCalledWith("user-1", "openai", freshJson);
    expect(result).toBe(freshJson);
  });

  it("refreshes a credential expiring inside the skew window", async () => {
    const nearlyStale = codexCredential(
      new Date(Date.now() + HARNESS_CREDENTIAL_REFRESH_SKEW_MS / 2),
    );
    const freshJson = codexCredential(new Date(Date.now() + 8 * HOUR));
    const store = fakeStore();
    const refresh = vi.fn(async () => ({ credentialJson: freshJson, expiresAt: null }));

    const result = await refreshHarnessCliCredentialIfStale({
      store,
      userId: "user-1",
      provider: "anthropic",
      credentialJson: nearlyStale,
      refresh,
    });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result).toBe(freshJson);
  });

  it("leaves a fresh credential untouched (no refresh, no store)", async () => {
    const fresh = codexCredential(new Date(Date.now() + 8 * HOUR));
    const store = fakeStore();
    const refresh = vi.fn();

    const result = await refreshHarnessCliCredentialIfStale({
      store,
      userId: "user-1",
      provider: "openai",
      credentialJson: fresh,
      refresh,
    });

    expect(refresh).not.toHaveBeenCalled();
    expect(store.store).not.toHaveBeenCalled();
    expect(result).toBe(fresh);
  });

  it("mounts as-is when the expiry cannot be determined (conservative)", async () => {
    const opaque = JSON.stringify({ tokens: { access_token: "not-a-jwt" } });
    const refresh = vi.fn();

    const result = await refreshHarnessCliCredentialIfStale({
      store: fakeStore(),
      userId: "user-1",
      provider: "openai",
      credentialJson: opaque,
      refresh,
    });

    expect(refresh).not.toHaveBeenCalled();
    expect(result).toBe(opaque);
  });

  it("never attempts refresh for providers the refresher does not support", async () => {
    const stale = codexCredential(new Date(Date.now() - HOUR));
    const refresh = vi.fn();

    const result = await refreshHarnessCliCredentialIfStale({
      store: fakeStore(),
      userId: "user-1",
      provider: "google",
      credentialJson: stale,
      refresh,
    });

    expect(refresh).not.toHaveBeenCalled();
    expect(result).toBe(stale);
  });

  it("recovers a concurrent fire's newer credential when its own refresh fails", async () => {
    const stale = codexCredential(new Date(Date.now() - HOUR));
    const winnersJson = codexCredential(new Date(Date.now() + 8 * HOUR));
    const store = fakeStore({ retrieve: vi.fn(async () => winnersJson) });
    const refresh = vi.fn(async () => {
      // Provider refresh tokens can be single-use: the concurrent fire's
      // refresh rotated it out from under us.
      throw new Error("invalid_grant");
    });

    const result = await refreshHarnessCliCredentialIfStale({
      store,
      userId: "user-1",
      provider: "openai",
      credentialJson: stale,
      refresh,
    });

    expect(store.retrieve).toHaveBeenCalledWith("user-1", "openai");
    expect(result).toBe(winnersJson);
  });

  it("throws a user-actionable error when the credential is already expired and refresh fails", async () => {
    const stale = codexCredential(new Date(Date.now() - HOUR));
    const store = fakeStore({ retrieve: vi.fn(async () => stale) });
    const refresh = vi.fn(async () => {
      throw new Error("invalid_grant");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const attempt = refreshHarnessCliCredentialIfStale({
        store,
        userId: "user-1",
        provider: "openai",
        credentialJson: stale,
        refresh,
      });

      // Mounting a provably dead token guarantees a cryptic harness 401;
      // failing fast carries a reconnect instruction to the run's FAILED card.
      await expect(attempt).rejects.toBeInstanceOf(HarnessCredentialExpiredError);
      await attempt.catch((error: HarnessCredentialExpiredError) => {
        expect(error.userMessage).toContain("OpenAI (Codex) credentials have expired");
        expect(error.userMessage).toContain("Reconnect");
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("harness credential refresh FAILED"),
        expect.objectContaining({ provider: "openai", userId: "user-1", expired: true }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("mounts as-is (with a loud warning) when refresh fails inside the skew window but before expiry", async () => {
    const nearlyStale = codexCredential(
      new Date(Date.now() + HARNESS_CREDENTIAL_REFRESH_SKEW_MS / 2),
    );
    const store = fakeStore({ retrieve: vi.fn(async () => nearlyStale) });
    const refresh = vi.fn(async () => {
      throw new Error("invalid_grant");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await refreshHarnessCliCredentialIfStale({
        store,
        userId: "user-1",
        provider: "openai",
        credentialJson: nearlyStale,
        refresh,
      });

      // Not yet past the cliff: the run may still finish — don't fail a run
      // that could succeed.
      expect(result).toBe(nearlyStale);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
