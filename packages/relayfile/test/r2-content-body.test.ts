import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class DurableObject {},
}));

const { r2ContentBody } = await import("../src/durable-objects/workspace.js");

// cloud#2319: the sync commit path put base64 content into R2 as a length-less
// ReadableStream (base64StringToByteStream), which workerd rejects with
// "Provided readable stream must have a known length …" → the mount sync cycle
// 500'd on every binary writeback and stalled. r2ContentBody must hand R2 a
// fixed-length body.
describe("r2ContentBody (cloud#2319)", () => {
  it("returns a fixed-length ArrayBuffer for base64 content, not a length-less stream", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 127, 128, 65, 66, 10]);
    const b64 = Buffer.from(bytes).toString("base64");

    const body = await r2ContentBody(b64, "base64");

    expect(body).toBeInstanceOf(ArrayBuffer);
    expect(body).not.toBeInstanceOf(ReadableStream);
    expect((body as ArrayBuffer).byteLength).toBe(bytes.length);
    expect(new Uint8Array(body as ArrayBuffer)).toEqual(bytes);
  });

  it("decodes whitespace-bearing base64 to the exact bytes", async () => {
    const bytes = new Uint8Array(300).map((_, i) => i % 256);
    // chunk the base64 with newlines to exercise the decoder's whitespace handling
    const b64 = Buffer.from(bytes)
      .toString("base64")
      .replace(/(.{40})/g, "$1\n");

    const body = (await r2ContentBody(b64, "base64")) as ArrayBuffer;

    expect(body.byteLength).toBe(bytes.length);
    expect(new Uint8Array(body)).toEqual(bytes);
  });

  it("passes utf-8 content through unchanged (already fixed-length)", async () => {
    const body = await r2ContentBody("hello world", "utf-8");
    expect(body).toBe("hello world");
  });
});
