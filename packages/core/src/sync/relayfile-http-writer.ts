import { logHop } from "../observability/structured-log.js";

export const RELAYFILE_WRITER_AGENT_NAME = "nango-sync-worker";

export type RelayfileFetch = typeof fetch;

const MAX_LOGGED_RESPONSE_BODY = 512;

/**
 * Carries the HTTP status, the truncated response body, and the request
 * path so callers (record-writer, runtime tests) can surface the full
 * Relayfile failure shape end-to-end rather than just an error message.
 *
 * Always thrown with `cause` set to the underlying fetch error when the
 * failure is a network/DNS issue rather than an HTTP non-2xx; the
 * `error-cause.ts` chain walker will surface that on log emission.
 */
export class RelayfileHttpWriteError extends Error {
  readonly name = "RelayfileHttpWriteError";
  readonly status?: number;
  readonly path: string;
  readonly method: "GET" | "PUT" | "DELETE";
  readonly responseBody?: string;
  // PG-style code shim so the loggable surface is uniform with drizzle errors.
  readonly code: string;

  constructor(args: {
    status?: number;
    path: string;
    method: "GET" | "PUT" | "DELETE";
    responseBody?: string;
    message: string;
    cause?: unknown;
  }) {
    super(args.message, args.cause === undefined ? undefined : { cause: args.cause });
    this.status = args.status;
    this.path = args.path;
    this.method = args.method;
    this.responseBody = args.responseBody;
    this.code = `relayfile_http_${args.status ?? "network"}`;
  }
}

export type RelayfileHttpWriterOptions = {
  baseUrl: string;
  workspaceId: string;
  token: string | (() => string | Promise<string>);
  fetch?: RelayfileFetch;
};

export type RelayfileWriteInput = {
  path: string;
  contents: string;
  contentType?: string;
  baseRevision?: string;
};

export type RelayfileDeleteInput = {
  path: string;
  baseRevision?: string;
};

export type RelayfileWriteResult = {
  path: string;
  revision?: string;
};

export type RelayfileReadResult = {
  path?: string;
  content?: string;
  revision?: string;
  contentType?: string;
  encoding?: string;
};

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function buildFileUrl(baseUrl: string, workspaceId: string, path: string): string {
  const url = new URL(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/fs/file`,
    `${trimTrailingSlash(baseUrl)}/`,
  );
  url.searchParams.set("path", path);
  return url.toString();
}

async function readToken(token: RelayfileHttpWriterOptions["token"]): Promise<string> {
  return typeof token === "function" ? token() : token;
}

export class RelayfileHttpWriter {
  readonly #baseUrl: string;
  readonly #workspaceId: string;
  readonly #token: RelayfileHttpWriterOptions["token"];
  readonly #fetch: RelayfileFetch;

  constructor(options: RelayfileHttpWriterOptions) {
    this.#baseUrl = options.baseUrl;
    this.#workspaceId = options.workspaceId;
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
  }

  async writeFile(input: RelayfileWriteInput): Promise<RelayfileWriteResult> {
    let response: Response;
    try {
      response = await this.#fetch(
        buildFileUrl(this.#baseUrl, this.#workspaceId, input.path),
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${await readToken(this.#token)}`,
            "content-type": input.contentType ?? "application/json",
            "if-match": input.baseRevision ?? "*",
            "x-relayfile-agent-name": RELAYFILE_WRITER_AGENT_NAME,
          },
          body: input.contents,
        },
      );
    } catch (cause) {
      const err = new RelayfileHttpWriteError({
        path: input.path,
        method: "PUT",
        message: `Relayfile write network error for ${input.path}`,
        cause,
      });
      logHop({
        hop: "write",
        outcome: "error",
        note: "relayfile.put.network",
        error: err,
      });
      throw err;
    }

    if (!response.ok) {
      const responseBody = await readBoundedBody(response);
      const err = new RelayfileHttpWriteError({
        status: response.status,
        path: input.path,
        method: "PUT",
        responseBody,
        message: `Relayfile write failed (${response.status}) for ${input.path}`,
      });
      logHop({
        hop: "write",
        outcome: "error",
        note: "relayfile.put.http",
        error: err,
      });
      throw err;
    }

    return {
      path: input.path,
      revision: response.headers.get("etag") ?? undefined,
    };
  }

  async readFile(
    workspaceId: string,
    path: string,
    correlationId?: string,
    signal?: AbortSignal,
  ): Promise<RelayfileReadResult> {
    let response: Response;
    try {
      response = await this.#fetch(
        buildFileUrl(this.#baseUrl, workspaceId || this.#workspaceId, path),
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${await readToken(this.#token)}`,
            "x-relayfile-agent-name": RELAYFILE_WRITER_AGENT_NAME,
            ...(correlationId ? { "x-correlation-id": correlationId } : {}),
          },
          signal,
        },
      );
    } catch (cause) {
      const err = new RelayfileHttpWriteError({
        path,
        method: "GET",
        message: `Relayfile read network error for ${path}`,
        cause,
      });
      logHop({
        hop: "write",
        outcome: "error",
        note: "relayfile.get.network",
        error: err,
      });
      throw err;
    }

    if (!response.ok) {
      const responseBody = await readBoundedBody(response);
      const err = new RelayfileHttpWriteError({
        status: response.status,
        path,
        method: "GET",
        responseBody,
        message: `Relayfile read failed (${response.status}) for ${path}`,
      });
      if (response.status !== 404) {
        logHop({
          hop: "write",
          outcome: "error",
          note: "relayfile.get.http",
          error: err,
        });
      }
      throw err;
    }

    const body = (await response.json().catch(() => ({}))) as RelayfileReadResult;
    return {
      ...body,
      path: body.path ?? path,
      revision: body.revision ?? response.headers.get("etag") ?? undefined,
    };
  }

  async deleteFile(input: RelayfileDeleteInput): Promise<RelayfileWriteResult> {
    let response: Response;
    try {
      response = await this.#fetch(
        buildFileUrl(this.#baseUrl, this.#workspaceId, input.path),
        {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${await readToken(this.#token)}`,
            "if-match": input.baseRevision ?? "*",
            "x-relayfile-agent-name": RELAYFILE_WRITER_AGENT_NAME,
          },
        },
      );
    } catch (cause) {
      const err = new RelayfileHttpWriteError({
        path: input.path,
        method: "DELETE",
        message: `Relayfile delete network error for ${input.path}`,
        cause,
      });
      logHop({
        hop: "write",
        outcome: "error",
        note: "relayfile.delete.network",
        error: err,
      });
      throw err;
    }

    if (!response.ok && response.status !== 404) {
      const responseBody = await readBoundedBody(response);
      const err = new RelayfileHttpWriteError({
        status: response.status,
        path: input.path,
        method: "DELETE",
        responseBody,
        message: `Relayfile delete failed (${response.status}) for ${input.path}`,
      });
      logHop({
        hop: "write",
        outcome: "error",
        note: "relayfile.delete.http",
        error: err,
      });
      throw err;
    }

    return { path: input.path };
  }
}

async function readBoundedBody(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    if (text.length === 0) return undefined;
    return text.length > MAX_LOGGED_RESPONSE_BODY
      ? `${text.slice(0, MAX_LOGGED_RESPONSE_BODY)}…[truncated]`
      : text;
  } catch {
    return undefined;
  }
}
