import { encodeArWorkspaceId, parseCredential } from '@relaycast/types';
import { z } from 'zod';
import type { CredentialTagSigner } from './credentialTags.js';

const TAG_SHAPE = /^[a-z][0-9A-Za-z]{10}$/;
/** Per-workspace tag lists a remote tagger holds at once (insertion-order LRU). */
const DEFAULT_MAX_CACHED_WORKSPACES = 4096;
/**
 * How long a fetched list stays authoritative. A hit does not extend it, so a
 * hot workspace still drops a tag RelayAuth removed and `tag` sees a promotion.
 */
const DEFAULT_CACHE_TTL_MS = 60_000;
/** Bound on one RelayAuth fetch, including its body. Shared waiters reject with it. */
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

const TagsResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    tags: z.array(z.string().regex(TAG_SHAPE)).min(1),
  }),
});

export interface RemoteCredentialTaggerOptions {
  /** The RelayAuth origin, e.g. `https://auth.agentrelay.com`. */
  baseUrl: string;
  /** Bearer token RelayAuth expects on `GET /v1/relaycast/credential-tags/:wsid`. */
  token: string;
  /** Defaults to the global `fetch`; tests inject a fake. */
  fetch?: typeof globalThis.fetch;
  maxCachedWorkspaces?: number;
  /** How long a fetched tag list is reused. Defaults to 60s. `0` refetches after the in-flight call settles. */
  cacheTtlMs?: number;
  /** Bound on one RelayAuth fetch, including the body. Defaults to 10s. */
  fetchTimeoutMs?: number;
  /** Clock for cache expiry. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * A {@link CredentialTagSigner} whose tags live in RelayAuth instead of a
 * local keyring: `GET {baseUrl}/v1/relaycast/credential-tags/:wsid` with
 * `Authorization: Bearer <token>` answers `{ ok: true, data: { tags } }`,
 * every tag a credential for the workspace may carry, the current one first;
 * `404` is a workspace RelayAuth never tagged. Any other failure propagates:
 * a wrong answer would lock out valid credentials, so a failed fetch is
 * surfaced, not guessed.
 *
 * A workspace's tag list is reused until {@link RemoteCredentialTaggerOptions.cacheTtlMs}
 * and bounded at {@link RemoteCredentialTaggerOptions.maxCachedWorkspaces}
 * entries LRU. Expiry is measured from the fetch, not the last hit. Misses
 * and failures are not cached, so a workspace tagged a moment later is
 * retried. One in-flight fetch is shared per workspace; it rejects when the
 * fetch times out, and every waiter sees that rejection.
 */
export function remoteCredentialTagger(options: RemoteCredentialTaggerOptions): CredentialTagSigner {
  const base = relayAuthOrigin(options.baseUrl);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const maxEntries = options.maxCachedWorkspaces ?? DEFAULT_MAX_CACHED_WORKSPACES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error('maxCachedWorkspaces must be a positive integer');
  }
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  if (!Number.isFinite(cacheTtlMs) || cacheTtlMs < 0) throw new Error('cacheTtlMs must be a non-negative finite number');
  const fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  if (!Number.isFinite(fetchTimeoutMs) || fetchTimeoutMs <= 0) throw new Error('fetchTimeoutMs must be a positive finite number');
  const now = options.now ?? Date.now;

  interface CacheEntry {
    promise: Promise<readonly string[] | undefined>;
    /** Absolute expiry. A later hit does not move it. */
    expiresAt: number;
    /** False while the fetch is in flight, so concurrent callers share it even when `cacheTtlMs` is 0. */
    settled: boolean;
  }
  const cache = new Map<string, CacheEntry>();

  const fetchTags = async (wsid: string): Promise<readonly string[] | undefined> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Settled in `finally` so a completed fetch does not leave the race holding a forever-pending timeout.
    let finishTimeout: () => void = () => {};
    const timedOut = new Promise<never>((_, reject) => {
      finishTimeout = () => reject(new Error(`RelayAuth credential tags for workspace ${wsid}: timed out`));
      timer = setTimeout(() => {
        controller.abort();
        finishTimeout();
      }, fetchTimeoutMs);
    });
    void timedOut.catch(() => {});
    const work = (async () => {
      const response = await fetchImpl(`${base}/v1/relaycast/credential-tags/${wsid}`, {
        headers: { authorization: `Bearer ${options.token}` },
        redirect: 'error',
        signal: controller.signal,
      });
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`RelayAuth credential tags for workspace ${wsid}: HTTP ${response.status}`);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new Error(`RelayAuth credential tags for workspace ${wsid}: malformed response`);
      }
      const parsed = TagsResponseSchema.safeParse(body);
      if (!parsed.success) throw new Error(`RelayAuth credential tags for workspace ${wsid}: malformed response`);
      return parsed.data.data.tags;
    })();
    // The race can settle on the timeout while `work` later rejects from the abort.
    void work.catch(() => {});
    try {
      return await Promise.race([work, timedOut]);
    } finally {
      clearTimeout(timer);
      finishTimeout();
    }
  };

  const cachedTags = (wsid: string): Promise<readonly string[] | undefined> => {
    const hit = cache.get(wsid);
    if (hit && (!hit.settled || hit.expiresAt > now())) {
      cache.delete(wsid);
      cache.set(wsid, hit);
      return hit.promise;
    }
    const entry: CacheEntry = { promise: Promise.resolve(undefined), expiresAt: now() + cacheTtlMs, settled: false };
    entry.promise = fetchTags(wsid).then(
      (tags) => {
        if (cache.get(wsid) !== entry) return tags;
        if (tags === undefined) cache.delete(wsid);
        else entry.settled = true;
        return tags;
      },
      (error: unknown) => {
        if (cache.get(wsid) === entry) cache.delete(wsid);
        throw error;
      },
    );
    // Replace, then move to the tail. Eviction drops the oldest other entry, never this in-flight fetch.
    cache.delete(wsid);
    cache.set(wsid, entry);
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined || oldest === wsid) break;
      cache.delete(oldest);
    }
    return entry.promise;
  };

  const tagsFor = async (workspaceId: string): Promise<readonly string[]> => {
    const tags = await cachedTags(encodeArWorkspaceId(workspaceId));
    if (!tags || tags.length === 0) throw new Error(`RelayAuth has no credential tag for workspace ${workspaceId}`);
    return tags;
  };

  return {
    async tag(workspaceId) {
      return (await tagsFor(workspaceId))[0]!;
    },
    async tags(workspaceId) {
      return tagsFor(workspaceId);
    },
    async verify(token) {
      const parsed = parseCredential(token);
      if (parsed?.family !== 'ar') return false;
      const tags = await cachedTags(encodeArWorkspaceId(parsed.workspaceId));
      return tags?.includes(parsed.tag) ?? false;
    },
  };
}

/** `baseUrl` as an origin. A path, query, fragment, or credential would send the bearer token somewhere else. */
export function relayAuthOrigin(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error('A remote credential tagger needs an http(s) base URL');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('A remote credential tagger needs an http(s) origin without credentials, path, query or fragment');
  }
  return url.origin;
}
