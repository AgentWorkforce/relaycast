import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  base64DecodedSize,
  base64StringToByteStream,
  hashContent,
} from "../src/durable-objects/content-hash.js";

// Independent old===new parity gate for #1241 W2/W3 (claude-2 reviewer).
// Oracle = whole-buffer hashing via node:crypto, exactly mirroring the
// origin/main behavior (utf-8: TextEncoder.encode(wholeString); base64:
// decode-then-hash). If hashContent ever drifts from this, content-hash/etag
// values change on deploy -> mass re-sync. The astral cases pin the
// surrogate-split regression the original suite missed.

const CHUNK = 64 * 1024; // mirrors STRING_CHUNK_CHARS in content-hash.ts

function utf8Oracle(content: string): string {
  return createHash("sha256")
    .update(Buffer.from(content, "utf-8"))
    .digest("hex");
}
function base64Oracle(content: string): string {
  // Buffer.from(_, "base64") is forgiving (ignores whitespace, handles padding)
  // exactly like atob's decode -> identical decoded bytes.
  return createHash("sha256")
    .update(Buffer.from(content, "base64"))
    .digest("hex");
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

describe("content-hash parity gate (old===new)", () => {
  const utf8Cases: Array<[string, string]> = [
    ["empty", ""],
    ["ascii", "hello world\n"],
    ["two-byte", "héllo wörld — café"],
    ["emoji-inline", "start 😀 middle 🚀 end"],
    [
      "astral-straddles-64k-boundary",
      `${"a".repeat(CHUNK - 1)}😀${"b".repeat(8)}`,
    ],
    [
      "astral-straddles-second-boundary",
      `${"x".repeat(2 * CHUNK - 1)}😀${"y".repeat(16)}`,
    ],
    [
      "large-multichunk-with-emoji",
      `${"z".repeat(CHUNK + 123)}😀${"q".repeat(CHUNK + 7)}`,
    ],
    ["crlf-text", "line1\r\nline2\r\n\tindented"],
  ];

  it.each(utf8Cases)(
    "utf-8 hash matches whole-buffer oracle: %s",
    async (_n, input) => {
      expect(await hashContent(input, "utf-8")).toBe(utf8Oracle(input));
    },
  );

  const bin = (bytes: number[]) => Buffer.from(bytes).toString("base64");
  const boundaryBytes = Buffer.alloc(CHUNK - 1, 0xab).toString("base64");
  const base64Cases: Array<[string, string]> = [
    ["empty", ""],
    ["pad0", Buffer.from("abc").toString("base64")], // YWJj
    ["pad1", Buffer.from("ab").toString("base64")], // YWI=
    ["pad2", Buffer.from("a").toString("base64")], // YQ==
    ["pad2-unpadded", Buffer.from("a").toString("base64").replace(/=+$/u, "")],
    ["binary", bin([0x00, 0x01, 0x02, 0xff, 0x7f, 0x80])],
    [
      "whitespace-wrapped",
      (() => {
        const b = Buffer.from([0, 1, 2, 255, 127, 128, 9, 10]).toString(
          "base64",
        );
        return `${b.slice(0, 4)}\n ${b.slice(4)}\t`;
      })(),
    ],
    [
      "large-binary-multichunk",
      Buffer.alloc(CHUNK + 999, 0xab).toString("base64"),
    ],
    [
      "whitespace-splits-quad-boundary",
      `${boundaryBytes.slice(0, CHUNK - 2)} \n${boundaryBytes.slice(CHUNK - 2)}`,
    ],
    ["short-quads-carried-across-whitespace", "T W\nF\tu\rTQ"],
  ];

  it.each(base64Cases)(
    "base64 hash matches decode-then-hash oracle: %s",
    async (_n, input) => {
      expect(await hashContent(input, "base64")).toBe(base64Oracle(input));
    },
  );

  it.each(base64Cases)(
    "base64 stream decode matches whole-buffer oracle: %s",
    async (_n, input) => {
      const decoded = await readStream(base64StringToByteStream(input));
      const oracle = Buffer.from(input, "base64");
      expect(decoded).toEqual(oracle);
      expect(base64DecodedSize(input)).toBe(decoded.byteLength);
      expect(await hashContent(input, "base64")).toBe(
        createHash("sha256").update(decoded).digest("hex"),
      );
    },
  );

  const sizeCases = [
    "",
    "TQ==",
    "TQ",
    "TWE=",
    "TWFu",
    "T W\nF\tu\r",
    "YWJjZA==",
    "TWFuTQ",
  ];
  it.each(sizeCases)("base64DecodedSize === atob(x).length: %j", (input) => {
    expect(base64DecodedSize(input)).toBe(atob(input).length);
  });
});
