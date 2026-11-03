import { encodeArWorkspaceId, parseCredential } from '@relaycast/types';
import type { CredentialTagSigner } from './credentialTags.js';

const TAG_SHAPE = /^[a-z][0-9A-Za-z]{10}$/;
/** Per-workspace tag lists a remote tagger holds at once (insertion-order LRU). */
const DEFAULT_MAX_CACHED_WORKSPACES = 4096;

export interface RemoteCredentialTaggerOptions {
  /** The RelayAuth origin, e.g. `https://auth.agentrelay.com`. */
  baseUrl: string;
  /** Bearer token RelayAuth expects on `GET /v1/relaycast/credential-tags/:wsid`. */
  token: string;
  /** Defaults to the global `fetch`; tests inject a fake. */
  fetch?: typeof globalThis.fetch;
  maxCachedWorkspaces?: number;
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
 * A workspace's tag list is cached indefinitely — a tag is immutable per key
 * version — and bounded at {@link RemoteCredentialTaggerOptions.maxCachedWorkspaces}
 * entries LRU. `verify` refetches once when a credential carries a version
 * letter the cached list does not know, the only way the list can grow
 * (a rotation RelayAuth already picked up). Misses and failures are not
 * cached.
 */
export function remoteCredentialTagger(options: RemoteCredentialTaggerOptions): CredentialTagSigner {
  const base = options.baseUrl.replace(/\/+$/, '');
  const { protocol } = new URL(base);
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new Error('A remote credential tagger needs an http(s) base URL');
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const maxEntries = options.maxCachedWorkspaces ?? DEFAULT_MAX_CACHED_WORKSPACES;
  const cache = new Map<string, Promise<readonly string[] | undefined>>();

  const fetchTags = async (wsid: string): Promise<readonly string[] | undefined> => {
    const response = await fetchImpl(`${base}/v1/relaycast/credential-tags/${wsid}`, {
      headers: { authorization: `Bearer ${options.token}` },
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`RelayAuth credential tags for workspace ${wsid}: HTTP ${response.status}`);
    const body = (await response.json()) as { ok?: boolean; data?: { tags?: unknown } };
    const tags = body?.ok === true ? body.data?.tags : undefined;
    if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string' && TAG_SHAPE.test(tag))) {
      throw new Error(`RelayAuth credential tags for workspace ${wsid}: malformed response`);
    }
    return tags;
  };

  const cachedTags = (wsid: string, refresh = false): Promise<readonly string[] | undefined> => {
    if (!refresh) {
      const hit = cache.get(wsid);
      if (hit) {
        cache.delete(wsid);
        cache.set(wsid, hit);
        return hit;
      }
    }
    const promise = fetchTags(wsid);
    cache.delete(wsid);
    cache.set(wsid, promise);
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
    void promise.then(
      // Only a known tag list is cached: a miss stays retriable (the
      // workspace may be tagged later), and so does a failure.
      (tags) => { if (tags === undefined && cache.get(wsid) === promise) cache.delete(wsid); },
      () => { if (cache.get(wsid) === promise) cache.delete(wsid); },
    );
    return promise;
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
      const wsid = encodeArWorkspaceId(parsed.workspaceId);
      const cached = await cachedTags(wsid);
      if (cached?.includes(parsed.tag)) return true;
      if (cached === undefined || new Set([...cached].map((tag) => tag[0])).has(parsed.keyVersion)) return false;
      return (await cachedTags(wsid, true))?.includes(parsed.tag) ?? false;
    },
  };
}
