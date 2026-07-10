import type { CorpusEntry } from "./corpus.js";

export interface ReplayedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  url: string;
}

export interface ReplayOptions {
  fetchImpl?: typeof fetch;
  /** Strip this path prefix before building the target URL. Defaults to "/cloud". */
  stripMountPrefix?: string | false;
  /** Allow POST/PUT/PATCH/DELETE requests. Defaults to false (safe mode). */
  allowMutations?: boolean;
  /** Per-request timeout in milliseconds. Defaults to 30_000 (30 s). */
  requestTimeoutMs?: number;
}

/** Methods that write/mutate server state. */
export const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "transfer-encoding",
]);

/** Default mount prefix recorded in corpus paths that must be dropped when
 *  replaying against the bare Next.js / Lambda URL. */
const DEFAULT_STRIP_PREFIX = "/cloud";

/** Default per-request fetch timeout (30 seconds). */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function normalizeBody(entry: CorpusEntry): string | undefined {
  if (entry.body == null) {
    return undefined;
  }
  if (entry.method === "GET" || entry.method === "HEAD") {
    return undefined;
  }
  return entry.body;
}

function normalizeHeaders(headers: Record<string, string>): Headers {
  const normalized = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lowerName)) {
      continue;
    }
    normalized.set(lowerName, value);
  }
  return normalized;
}

function responseHeadersToObject(headers: Headers): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    normalized[name.toLowerCase()] = value;
  }
  return normalized;
}

/**
 * Strip the leading mount prefix (e.g. `/cloud`) from a corpus path so the
 * replayed request hits the correct route on the bare target URL.
 */
export function stripMountPrefixFromPath(
  rawPath: string,
  prefix: string | false,
): string {
  if (prefix === false || prefix.length === 0) {
    return rawPath;
  }
  if (rawPath === prefix) {
    return "/";
  }
  if (rawPath.startsWith(`${prefix}/`)) {
    return rawPath.slice(prefix.length);
  }
  return rawPath;
}

export function buildTargetUrl(
  target: string,
  entry: CorpusEntry,
  stripPrefix: string | false = DEFAULT_STRIP_PREFIX,
): string {
  const baseUrl = new URL(target);
  baseUrl.pathname = stripMountPrefixFromPath(entry.path, stripPrefix);
  baseUrl.search = entry.query.length > 0 ? `?${entry.query}` : "";
  return baseUrl.toString();
}

export class MutationBlockedError extends Error {
  constructor(method: string, path: string) {
    super(
      `Replay blocked mutating request ${method} ${path}. ` +
        "Pass --allow-mutations (or allowMutations: true) to enable writes.",
    );
    this.name = "MutationBlockedError";
  }
}

export async function replayEntry(
  entry: CorpusEntry,
  target: string,
  options: ReplayOptions = {},
): Promise<ReplayedResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const stripPrefix =
    options.stripMountPrefix === undefined
      ? DEFAULT_STRIP_PREFIX
      : options.stripMountPrefix;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  if (MUTATING_METHODS.has(entry.method) && !options.allowMutations) {
    throw new MutationBlockedError(entry.method, entry.path);
  }

  const url = buildTargetUrl(target, entry, stripPrefix);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: entry.method,
      headers: normalizeHeaders(entry.headers),
      body: normalizeBody(entry),
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `Request timed out after ${timeoutMs} ms: ${entry.method} ${url}`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  return {
    status: response.status,
    headers: responseHeadersToObject(response.headers),
    body: await response.text(),
    url,
  };
}
