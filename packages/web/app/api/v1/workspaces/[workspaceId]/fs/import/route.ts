import crypto from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { mintRelayfileToken } from "@cloud/core/relayfile/client.js";
import { RelayFileClient, type BulkWriteFile } from "@relayfile/sdk";
import { NextRequest, NextResponse } from "next/server";
import * as tar from "tar";
import {
  requireAuthScope,
  requireSessionAuth,
  resolveRequestAuth,
} from "@/lib/auth/request-auth";
import { resolveRelayfileConfig } from "@/lib/relayfile";
import { isValidWorkspaceId } from "@/lib/relay-workspaces";
import {
  createCloudWorkspaceRegistry,
  hasWorkspaceOwnerAccess,
} from "@/lib/workspace-registry";

export const runtime = "nodejs";

const MAX_IMPORT_SIZE_BYTES = 500 * 1024 * 1024;
const MAX_DECOMPRESSED_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
const BULK_WRITE_BATCH_SIZE = 200;
const ADMIN_AGENT_NAME = "cloud-workspace-import";
const ANONYMOUS_OWNER_ID = "00000000-0000-0000-0000-000000000000";
const GZIP_CONTENT_TYPES = new Set(["application/gzip", "application/x-gzip"]);
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
  ".tiff",
  ".tif",
  ".wasm",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".a",
  ".o",
  ".obj",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".zst",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".mp3",
  ".mp4",
  ".wav",
  ".ogg",
  ".flac",
  ".avi",
  ".mov",
  ".mkv",
  ".webm",
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
  ".eot",
  ".pyc",
  ".pyo",
  ".class",
  ".jar",
  ".war",
  ".bin",
  ".dat",
  ".db",
  ".sqlite",
  ".sqlite3",
  ".ds_store",
]);

type ImportRouteContext = {
  params: Promise<{ workspaceId: string }>;
};

class PayloadTooLargeError extends Error {}
class InvalidArchiveError extends Error {}

function isGzipContentType(contentType: string | null): boolean {
  if (!contentType) {
    return false;
  }

  return GZIP_CONTENT_TYPES.has(contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "");
}

function isRegularFileType(type: string | undefined): boolean {
  return type === "File" || type === "OldFile" || type === "ContiguousFile";
}

function detectContentType(filePath: string, encoding: BulkWriteFile["encoding"]): string {
  if (encoding === "base64") {
    return "application/octet-stream";
  }

  const extension = path.posix.extname(filePath.toLowerCase());
  return BINARY_EXTENSIONS.has(extension)
    ? "application/octet-stream"
    : "text/plain; charset=utf-8";
}

function normalizeArchivePath(input: string): string | null {
  if (!input || input.includes("\0") || /^[A-Za-z]:/.test(input)) {
    return null;
  }

  const unixPath = input.replace(/\\/g, "/");
  let stripped = unixPath.replace(/^\/+/, "");
  while (stripped.startsWith("./")) {
    stripped = stripped.slice(2);
  }

  if (!stripped) {
    return null;
  }

  const parts = stripped.split("/");
  if (parts.some((part) => part === "..")) {
    return null;
  }

  const normalized = path.posix.normalize(stripped);
  if (!normalized || normalized === "." || normalized === "/" || normalized.startsWith("../")) {
    return null;
  }

  return `/${normalized}`;
}

function encodeFileContent(filePath: string, buffer: Buffer): Omit<BulkWriteFile, "path"> {
  const utf8 = buffer.toString("utf8");
  const encoding: BulkWriteFile["encoding"] = Buffer.from(utf8, "utf8").equals(buffer)
    ? "utf-8"
    : "base64";

  return {
    content: encoding === "utf-8" ? utf8 : buffer.toString("base64"),
    encoding,
    contentType: detectContentType(filePath, encoding),
  };
}

async function readRequestBody(request: NextRequest, maxBytes: number): Promise<Buffer> {
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      throw new PayloadTooLargeError(`Payload exceeds ${maxBytes} bytes`);
    }
  }

  if (!request.body) {
    return Buffer.alloc(0);
  }

  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      total += value.byteLength;
      if (total > maxBytes) {
        throw new PayloadTooLargeError(`Payload exceeds ${maxBytes} bytes`);
      }

      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks);
}

async function extractArchiveFiles(archive: Buffer): Promise<BulkWriteFile[]> {
  const files: BulkWriteFile[] = [];
  const entryReads: Promise<void>[] = [];
  const parser = new tar.Parser({ strict: true });
  let totalDecompressedBytes = 0;

  parser.on("entry", (entry: tar.ReadEntry) => {
    const entryRead = new Promise<void>((resolve, reject) => {
      const chunks: Buffer[] = [];

      entry.on("data", (chunk: Buffer | Uint8Array) => {
        totalDecompressedBytes += chunk.byteLength;
        if (totalDecompressedBytes > MAX_DECOMPRESSED_SIZE_BYTES) {
          entry.destroy();
          reject(new PayloadTooLargeError("Decompressed archive exceeds size limit"));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      entry.on("error", reject);
      entry.on("end", () => {
        try {
          if (isRegularFileType(entry.type)) {
            const normalizedPath = normalizeArchivePath(entry.path);
            if (!normalizedPath) {
              throw new InvalidArchiveError(`Invalid archive path: ${entry.path}`);
            }

            files.push({
              path: normalizedPath,
              ...encodeFileContent(normalizedPath, Buffer.concat(chunks)),
            });
          }

          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });

    entryReads.push(entryRead);
  });

  try {
    await pipeline(Readable.from(archive), createGunzip(), parser);
    await Promise.all(entryReads);
  } catch (error) {
    // Await any in-flight entry promises to prevent unhandled rejections
    // when the pipeline is destroyed mid-entry.
    await Promise.allSettled(entryReads);

    if (error instanceof PayloadTooLargeError) {
      throw error;
    }

    if (error instanceof InvalidArchiveError) {
      throw error;
    }

    throw new InvalidArchiveError("Invalid tar archive");
  }

  return files;
}

async function importFilesToWorkspace(workspaceId: string, files: BulkWriteFile[]): Promise<number> {
  const { relayfileUrl, relayAuthUrl, relayAuthApiKey } = resolveRelayfileConfig();
  if (!relayfileUrl || !relayAuthApiKey) {
    throw new Error("Relayfile unavailable");
  }

  // Workspace import is a trusted admin caller that may carry .relayfile.acl
  // entries in the incoming archive. The default scopes from
  // mintRelayfileToken don't include `admin:acl`, and the new permission-
  // marker guard in handlers/fs.ts rejects ACL mutations without it. Grant
  // admin:acl explicitly here so legitimate imports of workspaces with
  // existing ACL files don't 403 partway through bulkWrite.
  const client = new RelayFileClient({
    baseUrl: relayfileUrl,
    token: await mintRelayfileToken({
      workspaceId,
      relayAuthUrl,
      relayAuthApiKey,
      agentName: ADMIN_AGENT_NAME,
      scopes: ["fs:read", "fs:write", "sync:read", "sync:trigger", "admin:acl"],
    }),
  });

  let imported = 0;
  for (let index = 0; index < files.length; index += BULK_WRITE_BATCH_SIZE) {
    const batch = files.slice(index, index + BULK_WRITE_BATCH_SIZE);
    const result = await client.bulkWrite({
      workspaceId,
      files: batch,
      correlationId: `workspace-import-${workspaceId}-${crypto.randomUUID()}`,
    });

    if (result.errorCount > 0) {
      const firstError = result.errors[0];
      throw new Error(
        `Workspace import failed for ${firstError?.path ?? "unknown"}: ${firstError?.message ?? "unknown error"}`,
      );
    }

    imported += result.written;
  }

  return imported;
}

export async function POST(
  request: NextRequest,
  { params }: ImportRouteContext,
) {
  const auth = await resolveRequestAuth(request);
  const credentialsProvided = !!request.headers.get("authorization");

  if (!auth && credentialsProvided) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (auth && !requireSessionAuth(auth) && !requireAuthScope(auth, "cli:auth")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { workspaceId } = await params;
  if (!workspaceId || !isValidWorkspaceId(workspaceId)) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  if (!isGzipContentType(request.headers.get("content-type"))) {
    return NextResponse.json({ error: "Content-Type must be application/gzip" }, { status: 415 });
  }

  try {
    const { registry } = createCloudWorkspaceRegistry();
    const workspace = await registry.get(workspaceId);
    if (!workspace) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }

    const isAnonymousWorkspace = workspace.createdBy === ANONYMOUS_OWNER_ID;
    if (!isAnonymousWorkspace) {
      if (!auth || !hasWorkspaceOwnerAccess(workspace, auth.userId)) {
        return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
      }
    }

    const archive = await readRequestBody(request, MAX_IMPORT_SIZE_BYTES);
    const files = await extractArchiveFiles(archive);
    const imported = await importFilesToWorkspace(workspaceId, files);

    return NextResponse.json({ imported }, { status: 200 });
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }

    if (error instanceof InvalidArchiveError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    console.error("Workspace import failed:", error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: "Failed to import workspace files" }, { status: 500 });
  }
}
