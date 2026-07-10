import { Readable } from "node:stream";
import type { AxiosResponse } from "axios";
import { getNangoClient } from "./nango-service";

type GitHubRepoResponse = {
  default_branch?: unknown;
  head_sha?: unknown;
};

type GitHubCommitResponse = {
  sha?: unknown;
};

type ProxyHeaders = Record<string, string>;
type ProxyParams = Record<string, string | number | boolean | null | undefined>;
type SupportedMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function getRepoEndpoint(owner: string, repo: string): string {
  return `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}`;
}

function getTarballEndpoint(owner: string, repo: string, ref: string): string {
  return `${getRepoEndpoint(owner, repo)}/tarball/${encodePathSegment(ref)}`;
}

function getCommitEndpoint(owner: string, repo: string, ref: string): string {
  return `${getRepoEndpoint(owner, repo)}/commits/${encodePathSegment(ref)}`;
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!isRecord(headers)) return undefined;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      const value = headers[key];
      if (typeof value === "string") return value;
      if (Array.isArray(value) && typeof value[0] === "string") return value[0];
    }
  }
  return undefined;
}

function readContentLength(headers: unknown): number | undefined {
  const raw = readHeader(headers, "content-length");
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function normalizeParams(
  query?: ProxyParams,
): Record<string, string> | undefined {
  if (!query) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = String(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function axiosErrorResponse(
  error: unknown,
): { status: number; data: unknown; headers: unknown } | null {
  if (!isRecord(error)) return null;
  const response = error.response;
  if (!isRecord(response)) return null;
  const status = typeof response.status === "number" ? response.status : null;
  if (status === null) return null;
  return { status, data: response.data, headers: response.headers };
}

function buildProxyError(
  endpoint: string,
  fallback: string,
  errorData: unknown,
): Error {
  let message = fallback;
  if (isRecord(errorData)) {
    const extracted =
      readString(errorData.error) ?? readString(errorData.message);
    if (extracted) message = extracted;
  }
  return new Error(`Nango proxy ${endpoint} failed: ${message}`);
}

async function proxyJson<T extends Record<string, unknown>>(input: {
  connectionId: string;
  providerConfigKey: string;
  method: SupportedMethod;
  endpoint: string;
}): Promise<T> {
  const client = getNangoClient();
  try {
    const response = await client.proxy<T>({
      method: input.method,
      endpoint: input.endpoint,
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey,
    });
    if (!response.data) {
      throw new Error(
        `Nango proxy ${input.endpoint} returned an empty response.`,
      );
    }
    return response.data;
  } catch (error) {
    const info = axiosErrorResponse(error);
    if (info)
      throw buildProxyError(input.endpoint, `${info.status}`, info.data);
    if (error instanceof Error) throw error;
    throw new Error(`Nango proxy ${input.endpoint} failed: ${String(error)}`);
  }
}

export async function nangoGithubTarball(input: {
  connectionId: string;
  providerConfigKey: string;
  owner: string;
  repo: string;
  ref: string;
}): Promise<{
  stream: NodeJS.ReadableStream;
  headSha: string;
  defaultBranch: string;
  contentLength?: number;
}> {
  const repoEndpoint = getRepoEndpoint(input.owner, input.repo);
  const repoPayload = await proxyJson<
    GitHubRepoResponse & Record<string, unknown>
  >({
    connectionId: input.connectionId,
    providerConfigKey: input.providerConfigKey,
    method: "GET",
    endpoint: repoEndpoint,
  });
  const defaultBranch = readString(repoPayload.default_branch);
  if (!defaultBranch) {
    throw new Error(
      `Nango proxy ${repoEndpoint} did not return default_branch.`,
    );
  }
  const resolvedRef = input.ref === "HEAD" ? defaultBranch : input.ref;
  const commitEndpoint = getCommitEndpoint(
    input.owner,
    input.repo,
    resolvedRef,
  );
  const commitPayload = await proxyJson<
    GitHubCommitResponse & Record<string, unknown>
  >({
    connectionId: input.connectionId,
    providerConfigKey: input.providerConfigKey,
    method: "GET",
    endpoint: commitEndpoint,
  });

  const headSha =
    readString(commitPayload.sha) ?? readString(repoPayload.head_sha);
  if (!headSha) {
    throw new Error(`Nango proxy ${commitEndpoint} did not return sha.`);
  }
  const tarballEndpoint = getTarballEndpoint(input.owner, input.repo, headSha);
  const client = getNangoClient();
  const tarballResponse = (await client.proxy<NodeJS.ReadableStream>({
    method: "GET",
    endpoint: tarballEndpoint,
    connectionId: input.connectionId,
    providerConfigKey: input.providerConfigKey,
    responseType: "stream",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  })) as AxiosResponse<NodeJS.ReadableStream>;

  const rawStream = tarballResponse.data;
  if (!rawStream) {
    throw new Error(
      `Nango proxy ${tarballEndpoint} returned an empty tarball stream.`,
    );
  }

  const stream =
    rawStream instanceof Readable
      ? rawStream
      : Readable.from(rawStream as AsyncIterable<Uint8Array>);

  return {
    stream,
    headSha,
    defaultBranch,
    contentLength: readContentLength(tarballResponse.headers),
  };
}

export async function fetchGithubViaNango(input: {
  connectionId: string;
  providerConfigKey: string;
  method: SupportedMethod;
  path: string;
  query?: ProxyParams;
  body?: unknown;
  accept?: string;
}): Promise<Response> {
  const endpoint = input.path.startsWith("/") ? input.path : `/${input.path}`;
  const headers: ProxyHeaders = {
    Accept: input.accept ?? "application/json",
  };

  const client = getNangoClient();

  let status: number;
  let data: unknown;
  let responseHeaders: unknown;

  try {
    const response = await client.proxy<unknown>({
      method: input.method,
      endpoint,
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey,
      headers,
      responseType: "text",
      ...(normalizeParams(input.query)
        ? { params: normalizeParams(input.query) as Record<string, string> }
        : {}),
      ...(input.body === undefined ? {} : { data: input.body }),
    });
    status = response.status;
    data = response.data;
    responseHeaders = response.headers;
  } catch (error) {
    const info = axiosErrorResponse(error);
    if (!info) {
      if (error instanceof Error) throw error;
      throw new Error(`Nango proxy ${endpoint} failed: ${String(error)}`);
    }
    status = info.status;
    data = info.data;
    responseHeaders = info.headers;
  }

  const contentType =
    readHeader(responseHeaders, "content-type") ??
    (input.accept && input.accept.includes("diff")
      ? "text/plain"
      : "application/json");

  // Per Fetch spec, Response for 204/205/304 must have a null body — passing a
  // string (even "") makes the constructor throw, which would turn a valid
  // upstream no-content reply into a 502 from the route.
  if (status === 204 || status === 205 || status === 304) {
    return new Response(null, {
      status,
      headers: { "content-type": contentType },
    });
  }

  let body: string;
  if (typeof data === "string") {
    body = data;
  } else if (data === null || data === undefined) {
    body = "";
  } else {
    body = JSON.stringify(data);
  }

  return new Response(body, {
    status,
    headers: { "content-type": contentType },
  });
}
