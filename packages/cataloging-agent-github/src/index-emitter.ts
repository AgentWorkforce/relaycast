import {
  RelayFileApiError,
  type FileReadResponse,
  type FileSemantics,
  type WriteFileInput,
  type WriteQueuedResponse,
} from "@relayfile/sdk";

const INDEX_FINGERPRINT_PROPERTY = "cataloging.indexFingerprint";
const LAYOUT_FINGERPRINT_PROPERTY = "cataloging.layoutFingerprint";

export interface DirectoryIndexRow {
  id: string;
  title: string | null;
  updated: string;
  number?: number;
  state?: string;
}

export interface DirectoryIndexEntryInput {
  path: string;
  kind?: "file" | "dir";
  content?: string | Record<string, unknown> | null;
}

interface IndexEmitterRelayFileClient {
  readFile(
    workspaceId: string,
    path: string,
    correlationId?: string,
    signal?: AbortSignal,
  ): Promise<FileReadResponse>;
  writeFile(input: WriteFileInput): Promise<WriteQueuedResponse>;
}

export interface ManagedWriteResult {
  status: "written" | "skipped";
  path: string;
  fingerprint: string;
}

export function buildIndexRows(entries: readonly DirectoryIndexEntryInput[]): DirectoryIndexRow[] {
  return [...entries]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(toIndexRow)
    .filter((row): row is DirectoryIndexRow => row !== null);
}

export async function writeDirectoryIndex(input: {
  client: IndexEmitterRelayFileClient;
  workspaceId: string;
  directoryPath: string;
  entries: readonly DirectoryIndexEntryInput[];
  signal?: AbortSignal;
  correlationId?: string;
}): Promise<ManagedWriteResult> {
  const rows = buildIndexRows(input.entries);
  const path = `${trimTrailingSlash(input.directoryPath)}/_index.json`;
  const content = `${JSON.stringify(rows)}\n`;
  return writeManagedFile({
    client: input.client,
    workspaceId: input.workspaceId,
    path,
    content,
    contentType: "application/json; charset=utf-8",
    fingerprintProperty: INDEX_FINGERPRINT_PROPERTY,
    correlationId: input.correlationId ?? `cataloging:index:${path}`,
    signal: input.signal,
  });
}

export async function writeIntegrationLayout(input: {
  client: IndexEmitterRelayFileClient;
  workspaceId: string;
  path: string;
  body: string;
  signal?: AbortSignal;
  correlationId?: string;
}): Promise<ManagedWriteResult> {
  const content = input.body.endsWith("\n") ? input.body : `${input.body}\n`;
  const path = canonicalizeLayoutPath(input.path);
  return writeManagedFile({
    client: input.client,
    workspaceId: input.workspaceId,
    path,
    content,
    contentType: "text/markdown",
    fingerprintProperty: LAYOUT_FINGERPRINT_PROPERTY,
    correlationId: input.correlationId ?? `cataloging:layout:${path}`,
    signal: input.signal,
  });
}

function canonicalizeLayoutPath(path: string): string {
  return path.replace(/^\/([^/]+)\/\.layout\.md$/u, "/$1/LAYOUT.md");
}

async function writeManagedFile(input: {
  client: IndexEmitterRelayFileClient;
  workspaceId: string;
  path: string;
  content: string;
  contentType: string;
  fingerprintProperty: string;
  correlationId: string;
  signal?: AbortSignal;
}): Promise<ManagedWriteResult> {
  const fingerprint = await sha256Identity(input.content);
  let baseRevision = "0";
  let existingSemantics: FileSemantics | undefined;

  try {
    const existing = await input.client.readFile(
      input.workspaceId,
      input.path,
      input.correlationId,
      input.signal,
    );
    baseRevision = existing.revision;
    existingSemantics = existing.semantics;
    if (existing.semantics?.properties?.[input.fingerprintProperty] === fingerprint) {
      return {
        status: "skipped",
        path: input.path,
        fingerprint,
      };
    }
  } catch (error) {
    if (!(error instanceof RelayFileApiError) || error.status !== 404) {
      throw error;
    }
  }

  await input.client.writeFile({
    workspaceId: input.workspaceId,
    path: input.path,
    baseRevision,
    content: input.content,
    contentType: input.contentType,
    encoding: "utf-8",
    semantics: mergeSemantics(existingSemantics, input.fingerprintProperty, fingerprint),
    correlationId: input.correlationId,
    signal: input.signal,
  });

  return {
    status: "written",
    path: input.path,
    fingerprint,
  };
}

function toIndexRow(entry: DirectoryIndexEntryInput): DirectoryIndexRow | null {
  const kind = entry.kind ?? inferKind(entry.path);
  const basename = pathBasename(entry.path);
  if (!basename) {
    return null;
  }
  if (kind === "file" && basename === "_index.json") {
    return null;
  }

  const stem = kind === "file" ? basename.replace(/\.[^.]+$/, "") : basename;
  const { name, id } = parseNameAndId(stem);
  const parsed = parseJsonObject(entry.content);
  const number = readNumber(parsed?.number);
  const state = readString(parsed?.state);

  return {
    id: readString(parsed?.id) ?? id,
    title: readString(parsed?.title) ?? readString(parsed?.name) ?? readString(parsed?.checkName) ?? name,
    updated:
      readString(parsed?.updatedAt) ??
      readString(parsed?.updated_at) ??
      readString(parsed?.completedAt) ??
      readString(parsed?.completed_at) ??
      "",
    ...(number !== null ? { number } : {}),
    ...(state ? { state } : {}),
  };
}

function inferKind(path: string): "file" | "dir" {
  return /\.[^/]+$/.test(path) ? "file" : "dir";
}

function pathBasename(path: string): string {
  const trimmed = trimTrailingSlash(path);
  const segments = trimmed.split("/");
  return segments[segments.length - 1] ?? "";
}

function parseNameAndId(stem: string): { name: string; id: string } {
  const separator = stem.lastIndexOf("__");
  if (separator > 0 && separator < stem.length - 2) {
    return {
      name: decodePathSegment(stem.slice(0, separator)),
      id: decodePathSegment(stem.slice(separator + 2)),
    };
  }

  const value = decodePathSegment(stem);
  return { name: value, id: value };
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function trimTrailingSlash(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

function parseJsonObject(value: string | Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function mergeSemantics(
  existing: FileSemantics | undefined,
  fingerprintProperty: string,
  fingerprint: string,
): FileSemantics {
  return {
    ...existing,
    properties: {
      ...(existing?.properties ?? {}),
      [fingerprintProperty]: fingerprint,
    },
  };
}

async function sha256Identity(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return `sha256:${bytesToBase64Url(new Uint8Array(digest))}`;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
