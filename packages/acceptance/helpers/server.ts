import { Headers, fetch } from "undici";
import type { RequestInit as UndiciRequestInit } from "undici";

import { acceptanceEnv } from "./env";

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export const baseUrl = normalizeBaseUrl(acceptanceEnv().baseUrl);

export function resolveUrl(route: string): string {
  const pathname = route.startsWith("/") ? route.slice(1) : route;
  return new URL(pathname, `${baseUrl}/`).toString();
}

const MAX_ATTEMPTS = 7;
const BASE_DELAY_MS = 500;
const RATE_LIMIT_BASE_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientNetworkError(err: unknown): boolean {
  const code = (err as { code?: string; cause?: { code?: string } } | null)
    ?.code
    ?? (err as { cause?: { code?: string } } | null)?.cause?.code;
  return (
    code === "ETIMEDOUT"
    || code === "EHOSTUNREACH"
    || code === "ECONNRESET"
    || code === "UND_ERR_SOCKET"
    || code === "UND_ERR_CONNECT_TIMEOUT"
  );
}

export async function request(
  method: string,
  route: string,
  init?: UndiciRequestInit,
  options?: { noRetryStatuses?: number[] },
): Promise<Awaited<ReturnType<typeof fetch>>> {
  const headers = new Headers(init?.headers);
  const noRetryStatuses = options?.noRetryStatuses ?? [];

  if (!headers.has("accept")) {
    headers.set("accept", "application/json");
  }

  const url = resolveUrl(route);
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, method, headers });
      // Retry on 429 (rate limit) and 503 (transient unavailability — e.g.
      // Lambda concurrency throttle during traffic spikes). Both are non-
      // semantic backpressure responses that the test wants to look past
      // to assert the underlying contract.
      if (response.status !== 429 && response.status !== 503) {
        return response;
      }
      if (noRetryStatuses.includes(response.status)) {
        return response;
      }
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterSeconds = retryAfterHeader
        ? Number.parseFloat(retryAfterHeader)
        : Number.NaN;
      const backoff = Number.isFinite(retryAfterSeconds)
        ? Math.max(retryAfterSeconds * 1000, RATE_LIMIT_BASE_DELAY_MS)
        : RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt;
      // On the final attempt the caller gets the response back and will
      // read its body (e.g. `await response.json()` in auth-token.test.ts),
      // so we must NOT cancel the body here — that would leave the
      // returned response with a disturbed stream and every `.json()` /
      // `.text()` call would throw "stream already canceled". Only
      // discard the body when we're going to retry.
      if (attempt === MAX_ATTEMPTS - 1) {
        return response;
      }
      try {
        await response.body?.cancel();
      } catch {
        // ignore — we are discarding the throttled/unavailable response
      }
      await sleep(backoff + Math.random() * 250);
    } catch (err) {
      lastError = err;
      if (!isTransientNetworkError(err) || attempt === MAX_ATTEMPTS - 1) {
        throw err;
      }
      await sleep(BASE_DELAY_MS * 2 ** attempt + Math.random() * 250);
    }
  }
  throw lastError ?? new Error(`request to ${url} exhausted retries`);
}

export async function requestJson(
  route: string,
  init?: UndiciRequestInit,
): Promise<Awaited<ReturnType<typeof fetch>>> {
  return request(init?.method ?? "GET", route, init);
}
