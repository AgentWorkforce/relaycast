import path from "node:path";
import { TextDecoder } from "node:util";
import { createGunzip } from "node:zlib";
import * as tar from "tar";

export const GITHUB_CLONE_IGNORE_DIRS = [
  ".git",
  "node_modules",
  ".next",
  ".open-next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".yarn",
] as const;

export const GITHUB_CLONE_IGNORE_FILES = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
] as const;

export const GITHUB_CLONE_IGNORE_EXTS = [
  ".min.js",
  ".min.css",
  ".map",
] as const;

export const GITHUB_CLONE_MAX_FILE_BYTES = 1024 * 1024;

export const GITHUB_CLONE_BINARY_EXTS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp4",
  ".mov",
  ".wasm",
] as const;

export type WalkSkipReason = "binary-oversized" | "ignored" | "too-large";

export interface WalkedEntry {
  repoPath: string;
  content: Buffer;
  isBinary: boolean;
  size: number;
  skipped?: WalkSkipReason;
}

const MAX_BINARY_SNIFF_BYTES = 8 * 1024;
const IGNORE_DIR_SET = new Set<string>(GITHUB_CLONE_IGNORE_DIRS);
const IGNORE_FILE_SET = new Set<string>(GITHUB_CLONE_IGNORE_FILES);

function isRegularFileType(type: string | undefined): boolean {
  return type === "File" || type === "OldFile" || type === "ContiguousFile";
}

function normalizeTarEntryPath(entryPath: string): string | null {
  if (!entryPath || entryPath.includes("\0") || /^[A-Za-z]:/.test(entryPath)) {
    return null;
  }

  const unixPath = entryPath.replace(/\\/g, "/");
  let stripped = unixPath.replace(/^\/+/, "");
  while (stripped.startsWith("./")) {
    stripped = stripped.slice(2);
  }

  if (!stripped) {
    return null;
  }

  const parts = stripped.split("/").filter((part) => part.length > 0);
  if (parts.length < 2 || parts.some((part) => part === "." || part === "..")) {
    return null;
  }

  const repoPath = path.posix.normalize(parts.slice(1).join("/"));
  if (!repoPath || repoPath === "." || repoPath.startsWith("../")) {
    return null;
  }

  return repoPath;
}

function isIgnoredPath(repoPath: string): boolean {
  const parts = repoPath.split("/");
  const lowerParts = parts.map((part) => part.toLowerCase());
  if (lowerParts.some((part) => IGNORE_DIR_SET.has(part))) {
    return true;
  }

  const basename = lowerParts.at(-1);
  if (basename && IGNORE_FILE_SET.has(basename)) {
    return true;
  }

  const lowerPath = repoPath.toLowerCase();
  return GITHUB_CLONE_IGNORE_EXTS.some((extension) => lowerPath.endsWith(extension));
}

function hasKnownBinaryExtension(repoPath: string): boolean {
  const lowerPath = repoPath.toLowerCase();
  return GITHUB_CLONE_BINARY_EXTS.some((extension) => lowerPath.endsWith(extension));
}

function looksBinary(sniffBuffer: Buffer): boolean {
  return sniffBuffer.includes(0);
}

function isValidUtf8(content: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
    return true;
  } catch {
    return false;
  }
}

function toBuffer(chunk: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

function destroyStream(
  target: { destroy?: (error?: Error) => void } | null | undefined,
  error?: unknown,
): void {
  if (typeof target?.destroy !== "function") {
    return;
  }

  target.destroy(error instanceof Error ? error : error ? new Error(String(error)) : undefined);
}

async function readEntry(entry: tar.ReadEntry): Promise<WalkedEntry | null> {
  if (!isRegularFileType(entry.type)) {
    await new Promise<void>((resolve, reject) => {
      entry.once("end", resolve);
      entry.once("error", reject);
      entry.resume();
    });
    return null;
  }

  const repoPath = normalizeTarEntryPath(entry.path);
  if (!repoPath) {
    await new Promise<void>((resolve, reject) => {
      entry.once("end", resolve);
      entry.once("error", reject);
      entry.resume();
    });
    return null;
  }

  const ignored = isIgnoredPath(repoPath);
  const knownBinary = hasKnownBinaryExtension(repoPath);
  const chunks: Buffer[] = [];
  const sniffChunks: Buffer[] = [];
  let sniffBytes = 0;
  let size = 0;
  let tooLarge = !ignored && typeof entry.size === "number" && entry.size > GITHUB_CLONE_MAX_FILE_BYTES;

  return await new Promise<WalkedEntry>((resolve, reject) => {
    entry.on("data", (chunk: Buffer | Uint8Array) => {
      const buffer = toBuffer(chunk);
      size += buffer.byteLength;

      if (!knownBinary && sniffBytes < MAX_BINARY_SNIFF_BYTES) {
        const remaining = MAX_BINARY_SNIFF_BYTES - sniffBytes;
        const sniffChunk = buffer.subarray(0, remaining);
        if (sniffChunk.byteLength > 0) {
          sniffChunks.push(Buffer.from(sniffChunk));
          sniffBytes += sniffChunk.byteLength;
        }
      }

      if (ignored || tooLarge) {
        return;
      }

      if (size > GITHUB_CLONE_MAX_FILE_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }

      chunks.push(buffer);
    });

    entry.once("error", reject);
    entry.once("end", () => {
      const content = Buffer.concat(chunks);
      const isBinary = knownBinary
        || looksBinary(Buffer.concat(sniffChunks))
        || (!ignored && !tooLarge && !isValidUtf8(content));
      if (ignored) {
        resolve({
          repoPath,
          content: Buffer.alloc(0),
          isBinary,
          size,
          skipped: "ignored",
        });
        return;
      }

      if (tooLarge) {
        resolve({
          repoPath,
          content: Buffer.alloc(0),
          isBinary,
          size,
          skipped: "too-large",
        });
        return;
      }

      resolve({
        repoPath,
        content,
        isBinary,
        size,
      });
    });
  });
}

export async function* walkGithubTarball(
  stream: NodeJS.ReadableStream,
): AsyncGenerator<WalkedEntry> {
  const parser = new tar.Parser({ strict: true });
  const gunzip = createGunzip();
  const destroyableParser = parser as tar.Parser & { destroy?: (error?: Error) => void };
  const destroyableStream = stream as NodeJS.ReadableStream & {
    destroy?: (error?: Error) => void;
  };
  const queue: WalkedEntry[] = [];
  const entryReads = new Set<Promise<void>>();
  let pendingError: unknown;
  let parsingDone = false;
  let notify: (() => void) | null = null;

  const wake = () => {
    const current = notify;
    notify = null;
    current?.();
  };

  parser.on("entry", (entry: tar.ReadEntry) => {
    const entryRead = readEntry(entry)
      .then((walkedEntry) => {
        if (walkedEntry) {
          queue.push(walkedEntry);
        }
      })
      .catch((error) => {
        pendingError ??= error;
        destroyStream(gunzip, error);
        destroyStream(destroyableParser, error);
      })
      .finally(() => {
        entryReads.delete(entryRead);
        wake();
      });

    entryReads.add(entryRead);
  });

  const parsePromise = new Promise<void>((resolve, reject) => {
    parser.once("error", reject);
    parser.once("close", resolve);
    gunzip.once("error", reject);
    stream.once("error", reject);

    stream.pipe(gunzip).pipe(parser);
  })
    .then(async () => {
      await Promise.all(entryReads);
      parsingDone = true;
      wake();
    })
    .catch(async (error) => {
      await Promise.allSettled(entryReads);
      pendingError ??= error;
      parsingDone = true;
      wake();
    });

  try {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift() as WalkedEntry;
        continue;
      }

      if (pendingError) {
        throw pendingError;
      }

      if (parsingDone) {
        break;
      }

      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }

    await parsePromise;
    if (pendingError) {
      throw pendingError;
    }
  } finally {
    if (!parsingDone) {
      destroyStream(destroyableStream);
    }
  }
}

const githubTarballWalker = {
  GITHUB_CLONE_IGNORE_DIRS,
  GITHUB_CLONE_IGNORE_FILES,
  GITHUB_CLONE_IGNORE_EXTS,
  GITHUB_CLONE_MAX_FILE_BYTES,
  GITHUB_CLONE_BINARY_EXTS,
  walkGithubTarball,
};

export default githubTarballWalker;
