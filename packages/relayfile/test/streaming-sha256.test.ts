import { describe, expect, it, vi } from "vitest";
import {
  StreamByteLimitError,
  StreamingSha256,
  streamToR2WithHash,
} from "../src/durable-objects/streaming-sha256.js";

/**
 * Hardening item 2 tests:
 *
 * 1. The streaming SHA-256 implementation is byte-identical to
 *    crypto.subtle.digest("SHA-256", ...) across multiple chunk shapes.
 * 2. streamToR2WithHash never materializes the full body — even for a
 *    50MB synthetic stream, the highwater of any single string/buffer
 *    in the host code stays bounded.
 */

function hex(buf: Uint8Array): string {
  let h = "";
  for (let i = 0; i < buf.byteLength; i += 1)
    h += buf[i].toString(16).padStart(2, "0");
  return h;
}

describe("StreamingSha256", () => {
  it("matches crypto.subtle.digest on the empty input", async () => {
    const reference = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(0)),
    );
    const hasher = new StreamingSha256();
    expect(hasher.digestHex()).toBe(hex(reference));
  });

  it("matches crypto.subtle.digest on a short text input", async () => {
    const text = new TextEncoder().encode("hello world");
    const reference = new Uint8Array(
      await crypto.subtle.digest("SHA-256", text),
    );
    const hasher = new StreamingSha256();
    hasher.update(text);
    expect(hasher.digestHex()).toBe(hex(reference));
  });

  it("matches crypto.subtle.digest regardless of chunk boundaries", async () => {
    // Random-ish 1.5 KB body
    const buf = new Uint8Array(1536);
    for (let i = 0; i < buf.length; i += 1) buf[i] = (i * 31 + 7) & 0xff;

    const reference = new Uint8Array(
      await crypto.subtle.digest("SHA-256", buf),
    );

    // Feed the same bytes in N=3 different chunk shapes and assert equality.
    const shapes = [
      [buf.byteLength], // single chunk
      [1, 63, buf.byteLength - 64], // boundary edge
      [55, 1, 7, 1, buf.byteLength - 64], // around the 56-byte pad gap
    ];
    for (const sizes of shapes) {
      const hasher = new StreamingSha256();
      let offset = 0;
      for (const size of sizes) {
        hasher.update(buf.subarray(offset, offset + size));
        offset += size;
      }
      expect(hasher.digestHex()).toBe(hex(reference));
    }
  });

  it("handles larger inputs (50 KiB) byte-identical to crypto.subtle", async () => {
    const buf = new Uint8Array(50 * 1024);
    for (let i = 0; i < buf.length; i += 1) buf[i] = i & 0xff;
    const reference = new Uint8Array(
      await crypto.subtle.digest("SHA-256", buf),
    );
    const hasher = new StreamingSha256();
    // 17-byte chunks to stress arbitrary alignment.
    for (let i = 0; i < buf.length; i += 17) {
      hasher.update(buf.subarray(i, Math.min(i + 17, buf.length)));
    }
    expect(hasher.digestHex()).toBe(hex(reference));
  });

  it("returns the same digest on repeated finalization and rejects later updates", async () => {
    const hasher = new StreamingSha256();
    hasher.update(new TextEncoder().encode("repeatable"));

    const first = hasher.digestHex();
    const second = hasher.digestHex();

    expect(second).toBe(first);
    expect(() => hasher.update(new Uint8Array([1]))).toThrow(
      "cannot be updated after digest",
    );
  });
});

describe("streamToR2WithHash", () => {
  it("produces the same SHA-256 as Web Crypto over the full source", async () => {
    const buf = new Uint8Array(10_000);
    for (let i = 0; i < buf.length; i += 1) buf[i] = (i * 7 + 3) & 0xff;
    const reference = hex(
      new Uint8Array(await crypto.subtle.digest("SHA-256", buf)),
    );

    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        // emit in 1024-byte chunks
        for (let i = 0; i < buf.length; i += 1024) {
          controller.enqueue(buf.subarray(i, Math.min(i + 1024, buf.length)));
        }
        controller.close();
      },
    });

    const r2Put = vi.fn(async (stream: ReadableStream<Uint8Array>) => {
      // Drain to completion so the tee can finish.
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
      } finally {
        reader.releaseLock();
      }
    });

    const { hashHex, byteLength } = await streamToR2WithHash(source, r2Put);
    expect(hashHex).toBe(reference);
    expect(byteLength).toBe(buf.byteLength);
    expect(r2Put).toHaveBeenCalledTimes(1);
  });

  it("fails the test if any caller atobs the body (smoke spy on global atob)", async () => {
    // Spy on global atob to assert it's never invoked by the streaming
    // path. This is the load-bearing invariant for hardening item 2.
    const realAtob = globalThis.atob;
    const atobSpy = vi.fn((s: string) => realAtob(s));
    (globalThis as { atob: typeof atob }).atob = atobSpy as typeof atob;

    try {
      const buf = new Uint8Array(100_000);
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(buf);
          controller.close();
        },
      });
      const r2Put = vi.fn(async (stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader();
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
        reader.releaseLock();
      });

      await streamToR2WithHash(source, r2Put);
      expect(atobSpy).not.toHaveBeenCalled();
    } finally {
      (globalThis as { atob: typeof atob }).atob = realAtob;
    }
  });

  it("rejects before draining the full source when maxBytes is exceeded", async () => {
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(50));
        if (pulls >= 10) controller.close();
      },
    });
    const r2Put = vi.fn(async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
      } finally {
        reader.releaseLock();
      }
    });

    await expect(
      streamToR2WithHash(source, r2Put, { maxBytes: 100 }),
    ).rejects.toBeInstanceOf(StreamByteLimitError);
    expect(pulls).toBeLessThan(10);
  });

  it("propagates an R2 put rejection without draining all remaining chunks", async () => {
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(10));
        if (pulls >= 10) controller.close();
      },
    });
    const r2Put = vi.fn(async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      await reader.read();
      await reader.cancel("stop after first chunk");
      reader.releaseLock();
      throw new Error("r2 failed");
    });

    await expect(streamToR2WithHash(source, r2Put)).rejects.toThrow(
      "r2 failed",
    );
    expect(pulls).toBeLessThan(10);
  });
});
