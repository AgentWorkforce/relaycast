/**
 * Content-hash helpers for the workspace DO.
 *
 * Mirrors the daemon-side `hashBytes(content)` defined in
 * relayfile/internal/mountsync/syncer.go (SHA-256 hex of the raw bytes).
 *
 * Used to populate the `contentHash` field on FilesystemEvent, TreeEntry,
 * and FileReadResponse so the daemon can run its defensive cross-check from
 * relayfile PR #90:
 *
 *   if tracked.Revision == event.Revision && tracked.Hash != event.ContentHash {
 *       force re-fetch
 *   }
 *
 * The check is dormant until cloud actually emits `contentHash` — this module
 * is what wakes it up.
 */
import { StreamingSha256 } from "./streaming-sha256.js";

const BASE64_CHUNK_CHARS = 64 * 1024;

export async function hashContent(
  content: string,
  encoding: "utf-8" | "base64",
): Promise<string> {
  const hasher = new StreamingSha256();
  if (encoding === "base64") {
    forEachBase64DecodeChunk(content, (chunk) => {
      hasher.update(base64ChunkToBytes(chunk));
    });
  } else {
    hasher.update(new TextEncoder().encode(content));
  }
  return hasher.digestHex();
}

export function validateBase64Content(content: string): boolean {
  try {
    forEachBase64DecodeChunk(content, (chunk) => {
      // `atob` validates this bounded slice without decoding the whole file.
      atob(chunk);
    });
    return true;
  } catch {
    return false;
  }
}

export function base64DecodedSize(content: string): number {
  const { length, padding } = base64EffectiveLengthAndPadding(content);
  if (length === 0) {
    return 0;
  }
  return Math.max(0, Math.floor((length * 3) / 4) - padding);
}

export function base64StringToByteStream(
  content: string,
): ReadableStream<Uint8Array> {
  let offset = 0;
  let carry = "";
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      for (;;) {
        if (offset >= content.length) {
          if (carry.length > 0) {
            const bytes = base64ChunkToBytes(carry);
            carry = "";
            controller.enqueue(bytes);
            return;
          }
          controller.close();
          return;
        }

        const chunk = content.slice(offset, offset + BASE64_CHUNK_CHARS);
        offset += chunk.length;
        const emitted = emitCompleteBase64Chunks(
          carry + stripBase64Whitespace(chunk),
          (base64Chunk) => controller.enqueue(base64ChunkToBytes(base64Chunk)),
        );
        carry = emitted.carry;
        if (emitted.emitted) {
          return;
        }
      }
    },
  });
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function base64ChunkToBytes(chunk: string): Uint8Array {
  const decoded = atob(chunk);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i += 1) {
    bytes[i] = decoded.charCodeAt(i);
  }
  return bytes;
}

function forEachBase64DecodeChunk(
  content: string,
  fn: (chunk: string) => void,
): void {
  let carry = "";
  for (let offset = 0; offset < content.length; offset += BASE64_CHUNK_CHARS) {
    const normalized = stripBase64Whitespace(
      content.slice(offset, offset + BASE64_CHUNK_CHARS),
    );
    carry = emitCompleteBase64Chunks(carry + normalized, fn).carry;
  }
  if (carry.length > 0) {
    fn(carry);
  }
}

function emitCompleteBase64Chunks(
  value: string,
  fn: (chunk: string) => void,
): { carry: string; emitted: boolean } {
  const decodeLength = value.length - (value.length % 4);
  if (decodeLength <= 0) {
    return { carry: value, emitted: false };
  }
  fn(value.slice(0, decodeLength));
  return { carry: value.slice(decodeLength), emitted: true };
}

function base64EffectiveLengthAndPadding(content: string): {
  length: number;
  padding: number;
} {
  let length = 0;
  let previous = "";
  let last = "";
  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    if (isBase64Whitespace(char)) {
      continue;
    }
    length += 1;
    previous = last;
    last = char;
  }
  const padding = last === "=" ? (previous === "=" ? 2 : 1) : 0;
  return { length, padding };
}

function stripBase64Whitespace(value: string): string {
  let stripped = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (!isBase64Whitespace(char)) {
      stripped += char;
    }
  }
  return stripped;
}

function isBase64Whitespace(char: string): boolean {
  return (
    char === " " ||
    char === "\n" ||
    char === "\r" ||
    char === "\t" ||
    char === "\f"
  );
}
