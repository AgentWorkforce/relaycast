import { encodeArWorkspaceId, parseCredential } from '@relaycast/types';
import type { CredentialTagSigner } from './credentialTags.js';

const TAG_SHAPE = /^[a-z][0-9A-Za-z]{10}$/;
/** Per-workspace entries a remote tagger holds at once (insertion-order LRU). */
const DEFAULT_MAX_CACHED_WORKSPACES = 4096;
/** How long one RelayAuth answer is awaited before the request fails closed. */
export const DEFAULT_REMOTE_TAGS_TIMEOUT_MS = 3_000;
/** How long a fetched tag list is served before the next use revalidates it. */
export const DEFAULT_REMOTE_TAGS_TTL_MS = 5 * 60_000;
/** How long a `404` (an untagged workspace) is remembered. */
export const DEFAULT_REMOTE_TAGS_NEGATIVE_TTL_MS = 30_000;
/** Least time between two refetches forced by an unknown key version, per workspace. */
export const DEFAULT_UNKNOWN_VERSION_REFETCH_INTERVAL_MS = 30_000;

export interface RemoteCredentialTaggerOptions {
  /** The RelayAuth origin, e.g. `https://auth.agentrelay.com`. */
  baseUrl: string;
  /** Bearer token RelayAuth expects on `GET /v1/relaycast/credential-tags/:wsid`. */
  token: string;
  /** Defaults to the global `fetch`; tests inject a fake. */
  fetch?: typeof globalThis.fetch;
  maxCachedWorkspaces?: number;
  /** Per-request timeout; a request past it fails closed. Default {@link DEFAULT_REMOTE_TAGS_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Positive TTL: how long a tag list is served before it is revalidated. Default {@link DEFAULT_REMOTE_TAGS_TTL_MS}. */
  ttlMs?: number;
  /** Negative TTL: how long a `404` is remembered. Default {@link DEFAULT_REMOTE_TAGS_NEGATIVE_TTL_MS}. */
  negativeTtlMs?: number;
  /**
   * Least time between two refetches `verify` forces for a key version the
   * cached list does not know, per workspace. Default
   * {@link DEFAULT_UNKNOWN_VERSION_REFETCH_INTERVAL_MS}.
   */
  unknownVersionRefetchIntervalMs?: number;
  /** The clock (ms); tests inject one. */
  now?: () => number;
}

/** What the tagger holds for one workspace. */
interface Entry {
  /** RelayAuth's last answer: the tag list, or `undefined` for a `404`. */
  tags: readonly string[] | undefined;
  /** When `tags` was answered; `-Infinity` until the first answer. */
  answeredAt: number;
  /** When `verify` last forced a refetch for an unknown version. */
  forcedAt: number;
  /** The refresh in flight, shared by every caller that needs one meanwhile. */
  refresh?: Promise<readonly string[] | undefined>;
}

/**
 * A {@link CredentialTagSigner} whose tags live in RelayAuth instead of a
 * local keyring: `GET {baseUrl}/v1/relaycast/credential-tags/:wsid` with
 * `Authorization: Bearer <token>` answers `{ ok: true, data: { tags } }`,
 * every tag a credential for the workspace may carry, the current one first;
 * `404` is a workspace RelayAuth never tagged. Any other failure propagates:
 * a wrong answer would lock out valid credentials, so a failed fetch is
 * surfaced, not guessed. A request past `timeoutMs` is such a failure.
 *
 * Per workspace the tagger keeps RelayAuth's last answer, LRU-bounded at
 * `maxCachedWorkspaces` entries. A tag list is served for `ttlMs`; the next
 * use after that awaits one revalidation (shared by every concurrent caller),
 * so a current-version change is minted under within the TTL and a removed
 * version stops verifying once that refresh lands. A `404` is remembered for
 * `negativeTtlMs` (`verify` answers false and `tags` answers empty without a
 * request), but `tag` revalidates it at once: a mint must not fail because
 * RelayAuth tagged the workspace a moment ago. `verify` of a credential whose
 * version letter the cached list does not know forces one refetch (a
 * rotation RelayAuth already picked up), at most once per workspace per
 * `unknownVersionRefetchIntervalMs`; inside that window it answers false.
 * A failed or timed-out refresh is never cached: the stale entry stays and
 * the next use tries again.
 *
 * `tags` answers an empty list for an untagged workspace, so a derivation
 * replay (`derivationFamilies`) simply has no `ar` family to try; `tag` throws
 * instead, since nothing can be minted. A deployment minting `ar_`
 * credentials from RelayAuth therefore needs RelayAuth to tag a workspace
 * before (or when) the engine first mints for it, or a local keyring.
 */
export function remoteCredentialTagger(options: RemoteCredentialTaggerOptions): CredentialTagSigner {
  const base = options.baseUrl.replace(/\/+$/, '');
  const { protocol } = new URL(base);
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new Error('A remote credential tagger needs an http(s) base URL');
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const maxEntries = options.maxCachedWorkspaces ?? DEFAULT_MAX_CACHED_WORKSPACES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REMOTE_TAGS_TIMEOUT_MS;
  const ttlMs = options.ttlMs ?? DEFAULT_REMOTE_TAGS_TTL_MS;
  const negativeTtlMs = options.negativeTtlMs ?? DEFAULT_REMOTE_TAGS_NEGATIVE_TTL_MS;
  const unknownVersionIntervalMs = options.unknownVersionRefetchIntervalMs ?? DEFAULT_UNKNOWN_VERSION_REFETCH_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<string, Entry>();

  const fetchTags = async (wsid: string): Promise<readonly string[] | undefined> => {
    const describe = `RelayAuth credential tags for workspace ${wsid}`;
    let response: Response;
    try {
      response = await fetchImpl(`${base}/v1/relaycast/credential-tags/${wsid}`, {
        headers: { authorization: `Bearer ${options.token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') throw new Error(`${describe}: no answer within ${timeoutMs} ms`);
      throw error;
    }
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`${describe}: HTTP ${response.status}`);
    const body = (await response.json()) as { ok?: boolean; data?: { tags?: unknown } };
    const tags = body?.ok === true ? body.data?.tags : undefined;
    if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string' && TAG_SHAPE.test(tag))) {
      throw new Error(`${describe}: malformed response`);
    }
    // An empty list is a workspace with nothing to carry: the same as a 404.
    return tags.length > 0 ? tags : undefined;
  };

  /** The entry for `wsid`, created on first sight, marked most recently used. */
  const entryFor = (wsid: string): Entry => {
    let entry = cache.get(wsid);
    if (entry) {
      cache.delete(wsid);
    } else {
      entry = { tags: undefined, answeredAt: -Infinity, forcedAt: -Infinity };
    }
    cache.set(wsid, entry);
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
    return entry;
  };

  /** Start a refresh of `entry`, or join the one in flight. */
  const refresh = (wsid: string, entry: Entry): Promise<readonly string[] | undefined> => {
    if (entry.refresh) return entry.refresh;
    const promise = fetchTags(wsid).then((tags) => {
      entry.tags = tags;
      entry.answeredAt = now();
      return tags;
    });
    entry.refresh = promise;
    void promise.then(
      () => { if (entry.refresh === promise) entry.refresh = undefined; },
      () => {
        if (entry.refresh === promise) entry.refresh = undefined;
        // An entry RelayAuth never answered holds no stale list worth a slot.
        if (entry.answeredAt === -Infinity && cache.get(wsid) === entry) cache.delete(wsid);
      },
    );
    return promise;
  };

  const fresh = (entry: Entry): boolean =>
    entry.answeredAt + (entry.tags ? ttlMs : negativeTtlMs) > now();

  /** The workspace's tag list, undefined when RelayAuth has none; revalidated past its TTL. */
  const tagsOf = (wsid: string, { revalidateMiss = false } = {}): Promise<readonly string[] | undefined> => {
    const entry = entryFor(wsid);
    if (fresh(entry) && !(revalidateMiss && entry.tags === undefined)) return Promise.resolve(entry.tags);
    return refresh(wsid, entry);
  };

  return {
    async tag(workspaceId) {
      const tags = await tagsOf(encodeArWorkspaceId(workspaceId), { revalidateMiss: true });
      if (!tags) throw new Error(`RelayAuth has no credential tag for workspace ${workspaceId}`);
      return tags[0]!;
    },
    async tags(workspaceId) {
      return (await tagsOf(encodeArWorkspaceId(workspaceId))) ?? [];
    },
    async verify(token) {
      const parsed = parseCredential(token);
      if (parsed?.family !== 'ar') return false;
      const wsid = encodeArWorkspaceId(parsed.workspaceId);
      const tags = await tagsOf(wsid);
      if (!tags) return false;
      if (tags.includes(parsed.tag)) return true;
      if (tags.some((tag) => tag[0] === parsed.keyVersion)) return false;
      // A version the list does not know: a rotation RelayAuth may have
      // picked up since. One forced refetch per workspace per interval; the
      // rest of the window answers false, so unknown letters cannot drive
      // a request each.
      const entry = entryFor(wsid);
      const at = now();
      if (at - entry.forcedAt < unknownVersionIntervalMs) return false;
      entry.forcedAt = at;
      return (await refresh(wsid, entry))?.includes(parsed.tag) ?? false;
    },
  };
}
