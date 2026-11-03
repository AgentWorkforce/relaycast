import { describe, expect, it } from 'vitest';
import { encodeArCredential, encodeArWorkspaceId } from '@relaycast/types';
import { remoteCredentialTagger } from '../auth/remoteCredentialTags.js';
import { generateWorkspaceId } from '../gateway.js';

/**
 * `remoteCredentialTagger` against a fake RelayAuth: tags come from
 * `GET {baseUrl}/v1/relaycast/credential-tags/:wsid`, `{ ok: true, data: { tags } }`,
 * the current tag first; 404 is a workspace RelayAuth never tagged.
 */
const WS = generateWorkspaceId();
const WSID = encodeArWorkspaceId(WS);
const TAGS = ['aAAA111bbb2', 'bBBB222ccc3']; // tag shape: version letter + 10 base62
const credential = (tag: string, workspaceId = WS) =>
  encodeArCredential({ kind: 'workspace', workspaceId, tag, secret: new Uint8Array(32).fill(9) });

function fakeFetch(handler: (call: { url: string; token?: string }) => Response) {
  const calls: string[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
    return handler({ url, token: authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined }).clone();
  };
  return { calls, fetch: fetch as typeof globalThis.fetch };
}

const tagsResponse = (tags: readonly string[] = TAGS) =>
  Response.json({ ok: true, data: { tags } });

describe('remote credential tagger', () => {
  it('fetches tags once per workspace and serves tag/tags/verify from the cache', async () => {
    const { calls, fetch } = fakeFetch(({ url, token }) => {
      expect(token).toBe('relayauth-token');
      expect(url).toBe(`https://relayauth.test/v1/relaycast/credential-tags/${WSID}`);
      return tagsResponse();
    });
    const tagger = remoteCredentialTagger({ baseUrl: 'https://relayauth.test/', token: 'relayauth-token', fetch });

    expect(await tagger.tag(WS)).toBe(TAGS[0]);
    expect(await tagger.tags(WS)).toEqual(TAGS);
    expect(await tagger.verify(credential(TAGS[1]))).toBe(true);
    expect(await tagger.verify(credential('aZZZ999yyy8'))).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('refetches once for a tag under a version the cached list does not know', async () => {
    let served = TAGS.slice(0, 1);
    const { calls, fetch } = fakeFetch(() => tagsResponse(served));
    const tagger = remoteCredentialTagger({ baseUrl: 'https://relayauth.test', token: 'relayauth-token', fetch });

    expect(await tagger.verify(credential(TAGS[0]))).toBe(true);
    // A rotation added version 'b' after the cache filled: one refetch picks it up.
    served = TAGS;
    expect(await tagger.verify(credential(TAGS[1]))).toBe(true);
    expect(calls).toHaveLength(2);
    expect(await tagger.verify(credential(TAGS[1]))).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('refuses a forged tag under a known version without a second fetch', async () => {
    const { calls, fetch } = fakeFetch(() => tagsResponse());
    const tagger = remoteCredentialTagger({ baseUrl: 'https://relayauth.test', token: 'relayauth-token', fetch });
    expect(await tagger.verify(credential('aZZZ999yyy8'))).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('refuses credentials of a workspace RelayAuth never tagged, and does not cache the miss', async () => {
    let found = false;
    const { calls, fetch } = fakeFetch(({ url }) =>
      found && url.endsWith(`/${WSID}`) ? tagsResponse() : new Response(null, { status: 404 }));
    const tagger = remoteCredentialTagger({ baseUrl: 'https://relayauth.test', token: 'relayauth-token', fetch });

    expect(await tagger.verify(credential(TAGS[0]))).toBe(false);
    found = true;
    expect(await tagger.verify(credential(TAGS[0]))).toBe(true);
    expect(calls).toHaveLength(2);
    await expect(tagger.tag(generateWorkspaceId())).rejects.toThrow(/no credential tag/);
  });

  it('refuses non-ar_ credentials', async () => {
    const { fetch } = fakeFetch(() => tagsResponse());
    const tagger = remoteCredentialTagger({ baseUrl: 'https://relayauth.test', token: 'relayauth-token', fetch });
    expect(await tagger.verify(`rk_live_${'0'.repeat(32)}`)).toBe(false);
  });

  it('fails closed on RelayAuth errors and malformed bodies', async () => {
    for (const response of [
      new Response(null, { status: 500 }),
      Response.json({ ok: false, error: { code: 'nope' } }),
      Response.json({ ok: true, data: { tags: 'not-an-array' } }),
      Response.json({ ok: true, data: { tags: ['not a tag shape'] } }),
    ]) {
      const { fetch } = fakeFetch(() => response);
      const tagger = remoteCredentialTagger({ baseUrl: 'https://relayauth.test', token: 'relayauth-token', fetch });
      await expect(tagger.tags(WS)).rejects.toThrow();
      await expect(tagger.verify(credential(TAGS[0]))).rejects.toThrow();
    }
    const { fetch: down } = fakeFetch(() => { throw new Error('socket hangup'); });
    const tagger = remoteCredentialTagger({ baseUrl: 'https://relayauth.test', token: 'relayauth-token', fetch: down });
    await expect(tagger.tags(WS)).rejects.toThrow('socket hangup');
  });

  it('bounds the per-workspace cache, evicting the least recently used entry', async () => {
    const { calls, fetch } = fakeFetch(() => tagsResponse());
    const tagger = remoteCredentialTagger({
      baseUrl: 'https://relayauth.test',
      token: 'relayauth-token',
      fetch,
      maxCachedWorkspaces: 2,
    });
    const workspaces = [generateWorkspaceId(), generateWorkspaceId(), generateWorkspaceId()];
    await tagger.tags(workspaces[0]);
    await tagger.tags(workspaces[1]);
    await tagger.tags(workspaces[0]); // refresh workspaces[0]; workspaces[1] is now oldest
    await tagger.tags(workspaces[2]); // evicts workspaces[1]
    expect(calls).toHaveLength(3);
    await tagger.tags(workspaces[0]); // still cached
    expect(calls).toHaveLength(3);
    await tagger.tags(workspaces[1]); // evicted, fetched again
    expect(calls).toHaveLength(4);
  });

  it('rejects a base URL that is not http(s)', async () => {
    expect(() => remoteCredentialTagger({ baseUrl: 'not a url', token: 't' })).toThrow();
    expect(() => remoteCredentialTagger({ baseUrl: 'ftp://relayauth.test', token: 't' })).toThrow();
  });
});
