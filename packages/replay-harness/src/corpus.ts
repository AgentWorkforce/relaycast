import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface CorpusEntry {
  timestamp: string;
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: string | null;
  response_status: number;
  response_headers: Record<string, string>;
  response_body: string | null;
  request_id: string;
}

type RawCorpusEntry = {
  // The production traffic recorder (packages/router/src/recorder.ts)
  // writes `ts` / `request_headers` / `request_body`; older/hand-written
  // corpora use `timestamp` / `headers` / `body`. Accept both so the gate
  // runs against the real recorded corpus without re-recording.
  timestamp?: unknown;
  ts?: unknown;
  method: unknown;
  path: unknown;
  query?: unknown;
  headers?: unknown;
  request_headers?: unknown;
  body?: unknown;
  request_body?: unknown;
  response_status: unknown;
  response_headers?: unknown;
  response_body?: unknown;
  request_id?: unknown;
};

function normalizeStringRecord(value: unknown, fieldName: string): Record<string, string> {
  if (value == null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object.`);
  }

  const normalized: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value)) {
    if (headerValue == null) {
      continue;
    }
    normalized[key.toLowerCase()] = Array.isArray(headerValue)
      ? headerValue.map((item) => String(item)).join(", ")
      : String(headerValue);
  }
  return normalized;
}

function normalizeQuery(value: unknown): string {
  if (value == null || value === "") {
    return "";
  }
  if (typeof value === "string") {
    return value.startsWith("?") ? value.slice(1) : value;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const params = new URLSearchParams();
    for (const [key, entryValue] of Object.entries(value)) {
      if (entryValue == null) {
        continue;
      }
      if (Array.isArray(entryValue)) {
        for (const item of entryValue) {
          params.append(key, String(item));
        }
        continue;
      }
      params.append(key, String(entryValue));
    }
    return params.toString();
  }
  throw new Error("query must be a string, object, or null.");
}

function normalizeBody(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function normalizeEntry(value: RawCorpusEntry, lineNumber: number): CorpusEntry {
  // Prefer the recorder field (`ts`), fall back to legacy (`timestamp`) —
  // consistent with the request headers/body resolution below.
  const timestamp =
    typeof value.ts === "string" && value.ts.length > 0
      ? value.ts
      : typeof value.timestamp === "string" && value.timestamp.length > 0
        ? value.timestamp
        : null;
  if (timestamp === null) {
    throw new Error(`Line ${lineNumber}: timestamp must be a non-empty string.`);
  }
  if (typeof value.method !== "string" || value.method.length === 0) {
    throw new Error(`Line ${lineNumber}: method must be a non-empty string.`);
  }
  if (typeof value.path !== "string" || !value.path.startsWith("/")) {
    throw new Error(`Line ${lineNumber}: path must start with '/'.`);
  }
  if (typeof value.response_status !== "number" || !Number.isInteger(value.response_status)) {
    throw new Error(`Line ${lineNumber}: response_status must be an integer.`);
  }

  // Recorder writes `request_headers`/`request_body`; legacy corpora use
  // `headers`/`body`. Prefer the recorder names, fall back to legacy.
  const requestHeaders =
    value.request_headers !== undefined ? value.request_headers : value.headers;
  const requestBody =
    value.request_body !== undefined ? value.request_body : value.body;

  return {
    timestamp,
    method: value.method.toUpperCase(),
    path: value.path,
    query: normalizeQuery(value.query),
    headers: normalizeStringRecord(requestHeaders, "headers"),
    body: normalizeBody(requestBody),
    response_status: value.response_status,
    response_headers: normalizeStringRecord(value.response_headers, "response_headers"),
    response_body: normalizeBody(value.response_body),
    request_id: typeof value.request_id === "string" && value.request_id.length > 0
      ? value.request_id
      : `line-${lineNumber}`,
  };
}

function parseCorpusText(text: string): CorpusEntry[] {
  const entries: CorpusEntry[] = [];
  const lines = text.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let parsed: RawCorpusEntry;
    try {
      parsed = JSON.parse(trimmed) as RawCorpusEntry;
    } catch (error) {
      throw new Error(`Line ${index + 1}: invalid JSON. ${String(error)}`);
    }
    entries.push(normalizeEntry(parsed, index + 1));
  }

  return entries;
}

function createObjectStoreClient() {
  return new S3Client({
    region: process.env.AWS_REGION ?? "us-east-1",
    endpoint: process.env.R2_ENDPOINT
      ?? process.env.S3_ENDPOINT
      ?? process.env.AWS_ENDPOINT_URL_S3,
    forcePathStyle: true,
  });
}

async function readFromObjectStore(uri: URL): Promise<string> {
  const bucket = uri.hostname;
  const key = uri.pathname.replace(/^\/+/, "");
  if (!bucket || key.length === 0) {
    throw new Error(`Invalid object store corpus URI: ${uri.toString()}`);
  }

  const client = createObjectStoreClient();
  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );
  if (!response.Body) {
    throw new Error(`Corpus object ${uri.toString()} returned an empty body.`);
  }
  return response.Body.transformToString();
}

async function readCorpusText(corpusUri: string): Promise<string> {
  if (corpusUri.startsWith("http://") || corpusUri.startsWith("https://")) {
    const response = await fetch(corpusUri);
    if (!response.ok) {
      throw new Error(`Failed to fetch corpus ${corpusUri}: ${response.status}`);
    }
    return response.text();
  }

  if (corpusUri.startsWith("s3://") || corpusUri.startsWith("r2://")) {
    return readFromObjectStore(new URL(corpusUri));
  }

  if (corpusUri.startsWith("file://")) {
    const filePath = fileURLToPath(corpusUri);
    return fs.readFile(filePath, "utf8");
  }

  const resolvedPath = path.resolve(corpusUri);
  return fs.readFile(resolvedPath, "utf8");
}

export async function readCorpus(corpusUri: string): Promise<CorpusEntry[]> {
  const text = await readCorpusText(corpusUri);
  return parseCorpusText(text);
}

export function parseCorpusForTest(text: string): CorpusEntry[] {
  return parseCorpusText(text);
}
