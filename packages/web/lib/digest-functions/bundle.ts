import {
  DigestFunctionSource,
  DigestSourceFile,
  InvalidSourceError,
  QuotaExceededError,
} from "./types";
import { DEFAULT_DIGEST_BYTE_LIMIT } from "./quota";

const MAGIC = Buffer.from("DIGESTv1\0\0\0\0\0\0\0\0", "utf8");

function validate(src: DigestFunctionSource): void {
  if (!src || typeof src !== "object") {
    throw new InvalidSourceError("source is required");
  }
  if (!Array.isArray(src.files) || src.files.length === 0) {
    throw new InvalidSourceError("source.files must be a non-empty array");
  }
  if (typeof src.entrypoint !== "string" || src.entrypoint.length === 0) {
    throw new InvalidSourceError("source.entrypoint must be a non-empty string");
  }
  if (src.runtime !== "node20") {
    throw new InvalidSourceError(`unsupported runtime: ${String(src.runtime)}`);
  }
  const seen = new Set<string>();
  for (const file of src.files) {
    if (!file || typeof file.path !== "string" || file.path.length === 0) {
      throw new InvalidSourceError("file.path must be a non-empty string");
    }
    if (file.path.startsWith("/")) {
      throw new InvalidSourceError(`file.path must not be absolute: ${file.path}`);
    }
    if (file.path.split("/").some((seg) => seg === "..")) {
      throw new InvalidSourceError(`file.path must not contain ..: ${file.path}`);
    }
    if (typeof file.contents !== "string") {
      throw new InvalidSourceError(`file.contents must be a string: ${file.path}`);
    }
    if (seen.has(file.path)) {
      throw new InvalidSourceError(`duplicate file.path: ${file.path}`);
    }
    seen.add(file.path);
  }
  const entryPaths = new Set(src.files.map((f) => f.path));
  if (!entryPaths.has(src.entrypoint)) {
    throw new InvalidSourceError(
      `entrypoint ${src.entrypoint} not present in files`,
    );
  }
}

function compareByPath(a: DigestSourceFile, b: DigestSourceFile): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function u32BE(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value, 0);
  return buf;
}

function u64BE(value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(value), 0);
  return buf;
}

function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([u32BE(bytes.byteLength), bytes]);
}

function assertWithinLimit(bytes: number, limit: number): void {
  if (bytes > limit) {
    throw new QuotaExceededError(bytes, limit);
  }
}

export function bundleSource(
  src: DigestFunctionSource,
  byteLimit: number = DEFAULT_DIGEST_BYTE_LIMIT,
): Uint8Array {
  validate(src);
  const sorted = [...src.files].sort(compareByPath);
  let totalBytes =
    MAGIC.byteLength +
    4 +
    Buffer.byteLength(src.runtime, "utf8") +
    4 +
    Buffer.byteLength(src.entrypoint, "utf8") +
    4;
  assertWithinLimit(totalBytes, byteLimit);

  const parts: Buffer[] = [
    MAGIC,
    lengthPrefixed(src.runtime),
    lengthPrefixed(src.entrypoint),
    u32BE(sorted.length),
  ];
  for (const file of sorted) {
    totalBytes += 4 + Buffer.byteLength(file.path, "utf8");
    assertWithinLimit(totalBytes, byteLimit);
    parts.push(lengthPrefixed(file.path));

    const contentBytes = Buffer.byteLength(file.contents, "utf8");
    totalBytes += 8 + contentBytes;
    assertWithinLimit(totalBytes, byteLimit);
    const contents = Buffer.from(file.contents, "utf8");
    parts.push(u64BE(contentBytes));
    parts.push(contents);
  }
  const out = Buffer.concat(parts);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}
