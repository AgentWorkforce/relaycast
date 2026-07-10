import { describe, expect, it } from "vitest";

import { DEFAULT_DIGEST_BYTE_LIMIT, enforceQuota } from "./quota";
import { QuotaExceededError } from "./types";

describe("enforceQuota", () => {
  it("accepts a bundle within the limit", () => {
    expect(() => enforceQuota(new Uint8Array(1024))).not.toThrow();
  });

  it("accepts a bundle exactly at the limit", () => {
    expect(() => enforceQuota(new Uint8Array(DEFAULT_DIGEST_BYTE_LIMIT))).not.toThrow();
  });

  it("rejects a bundle over the limit", () => {
    expect(() =>
      enforceQuota(new Uint8Array(DEFAULT_DIGEST_BYTE_LIMIT + 1)),
    ).toThrow(QuotaExceededError);
  });

  it("attaches bytes and limit to the error", () => {
    try {
      enforceQuota(new Uint8Array(DEFAULT_DIGEST_BYTE_LIMIT + 5));
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaExceededError);
      const qe = err as QuotaExceededError;
      expect(qe.code).toBe("DIGEST_QUOTA_EXCEEDED");
      expect(qe.bytes).toBe(DEFAULT_DIGEST_BYTE_LIMIT + 5);
      expect(qe.limit).toBe(DEFAULT_DIGEST_BYTE_LIMIT);
    }
  });

  it("respects a custom limit", () => {
    expect(() => enforceQuota(new Uint8Array(11), 10)).toThrow(QuotaExceededError);
    expect(() => enforceQuota(new Uint8Array(10), 10)).not.toThrow();
  });

  it("exposes the default limit as 256 KiB", () => {
    expect(DEFAULT_DIGEST_BYTE_LIMIT).toBe(256 * 1024);
  });
});
