/**
 * Tests for `readBlobWithTimeoutRetry` via the exported `loadBodyFromR2`
 * call-site. The helper is the per-blob timeout + retry that turns an
 * unbounded ordered-head-of-line wedge (the #1300 failure mode) into a
 * bounded, self-healing read.
 *
 * Spec: docs/plans/export-stream-robustness.md (PR #1289 on
 * docs/durable-track-specs).
 *
 * Issue: AgentWorkforce/cloud#1309.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "hono";
import type { AppEnv } from "../src/env.js";
import { loadBodyFromR2 } from "../src/routes/export.js";

type R2Stub = {
  get: (ref: string) => Promise<{
    arrayBuffer: () => Promise<ArrayBuffer>;
    text?: () => Promise<string>;
  } | null>;
};

function makeCtx(
  env: Partial<{
    RELAYFILE_EXPORT_BLOB_READ_TIMEOUT_MS: string;
    RELAYFILE_EXPORT_BLOB_READ_ATTEMPTS: string;
    CONTENT_BUCKET: R2Stub;
  }>,
): Context<AppEnv> {
  return { env } as unknown as Context<AppEnv>;
}

function bytesFor(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

function neverResolvingGet(): () => Promise<never> {
  return () =>
    new Promise<never>(() => {
      // never resolve; the per-blob timeout must abort the wait
    });
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadBodyFromR2 — per-blob R2 read timeout + retry", () => {
  it("returns the body on the healthy path with no extra retries", async () => {
    const get = vi.fn(async (_ref: string) => ({
      arrayBuffer: async () => bytesFor("hello"),
    }));
    const ctx = makeCtx({
      RELAYFILE_EXPORT_BLOB_READ_TIMEOUT_MS: "200",
      RELAYFILE_EXPORT_BLOB_READ_ATTEMPTS: "3",
      CONTENT_BUCKET: { get },
    });

    const body = await loadBodyFromR2(ctx, {
      contentRef: "r2://blobs/abc",
      encoding: "utf-8",
    });

    expect(body).toBe("hello");
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("retries once when the first R2 read hangs past the timeout and returns on the next attempt", async () => {
    let call = 0;
    type R2Object = { arrayBuffer: () => Promise<ArrayBuffer> } | null;
    const get = vi.fn<(ref: string) => Promise<R2Object>>(async (_ref) => {
      call += 1;
      if (call === 1) {
        // Hang the first attempt — the per-blob timeout must abort it.
        return new Promise<R2Object>(() => {});
      }
      return { arrayBuffer: async () => bytesFor("recovered") };
    });

    const ctx = makeCtx({
      RELAYFILE_EXPORT_BLOB_READ_TIMEOUT_MS: "50",
      RELAYFILE_EXPORT_BLOB_READ_ATTEMPTS: "3",
      CONTENT_BUCKET: { get },
    });

    const body = await loadBodyFromR2(ctx, {
      contentRef: "r2://blobs/xyz",
      encoding: "utf-8",
    });

    expect(body).toBe("recovered");
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("throws cleanly after exhausting retries on a persistently hung R2 read", async () => {
    const get = vi.fn(neverResolvingGet());
    const ctx = makeCtx({
      RELAYFILE_EXPORT_BLOB_READ_TIMEOUT_MS: "30",
      RELAYFILE_EXPORT_BLOB_READ_ATTEMPTS: "3",
      CONTENT_BUCKET: { get },
    });

    await expect(
      loadBodyFromR2(ctx, {
        contentRef: "r2://blobs/wedged",
        encoding: "utf-8",
      }),
    ).rejects.toThrow(/timed out|R2 blob read failed/i);

    expect(get).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry a deterministic missing-blob (R2.get returns null)", async () => {
    const get = vi.fn(async () => null);
    const ctx = makeCtx({
      RELAYFILE_EXPORT_BLOB_READ_TIMEOUT_MS: "50",
      RELAYFILE_EXPORT_BLOB_READ_ATTEMPTS: "3",
      CONTENT_BUCKET: { get },
    });

    await expect(
      loadBodyFromR2(ctx, {
        contentRef: "r2://blobs/missing",
        encoding: "utf-8",
      }),
    ).rejects.toThrow(/missing from R2/i);

    // A missing blob is not transient — retrying wastes subrequests.
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("uses the default timeout/attempts when env is unset", async () => {
    // Healthy path: defaults still produce a working read. We're not
    // exercising the 8000ms default here (too slow for a unit test) — just
    // confirming the helper accepts an undefined env without throwing.
    const get = vi.fn(async () => ({
      arrayBuffer: async () => bytesFor("ok"),
    }));
    const ctx = makeCtx({ CONTENT_BUCKET: { get } });

    const body = await loadBodyFromR2(ctx, {
      contentRef: "r2://blobs/ok",
      encoding: "utf-8",
    });

    expect(body).toBe("ok");
  });
});
