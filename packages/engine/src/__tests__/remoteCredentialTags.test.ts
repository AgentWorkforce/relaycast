import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeArCredential, encodeArWorkspaceId } from '@relaycast/types';
import { derivationFamilies } from '../auth/credentials.js';
import { remoteCredentialTagger, type RemoteCredentialTaggerOptions } from '../auth/remoteCredentialTags.js';
import { nodes } from '../db/schema.js';
import { generateWorkspaceId } from '../gateway.js';
import { sha256Hex } from '../lib/crypto.js';
import { createWorkspace, makeNodeStack } from './conformance/harness.js';

/**
 * `remoteCredentialTagger` against a fake RelayAuth over real HTTP: tags come
 * from `GET {baseUrl}/v1/relaycast/credential-tags/:wsid`,
 * `{ ok: true, data: { tags } }`, the current tag first; 404 is a workspace
 * RelayAuth never tagged. The fake counts requests, can answer slowly, and
 * answers whatever status its current `reply` says.
 */
const WS = generateWorkspaceId();
const WSID = encodeArWorkspaceId(WS);
const TAGS = ['aAAA111bbb2', 'bBBB222ccc3']; // tag shape: version letter + 10 base62
const TOKEN = 'relayauth-token';
const credential = (tag: string, workspaceId = WS) =>
  encodeArCredential({ kind: 'workspace', workspaceId, tag, secret: new Uint8Array(32).fill(9) });

type Reply = { status: number; body?: unknown };
const ok = (tags: readonly string[] = TAGS): Reply => ({ status: 200, body: { ok: true, data: { tags } } });
const notFound: Reply = { status: 404 };

interface FakeRelayAuth {
  baseUrl: string;
  /** Every request seen: the wsid asked for and the bearer presented. */
  requests: { wsid: string; token?: string }[];
  /** The answer for a wsid; set per test. */
  reply: (wsid: string) => Reply;
  /** Delay before every answer. */
  latencyMs: number;
  /** Requests whose answer has not been written yet. */
  pending(): number;
  close(): Promise<void>;
}

function startFakeRelayAuth(): Promise<FakeRelayAuth> {
  const timers = new Set<NodeJS.Timeout>();
  const fake: FakeRelayAuth = {
    baseUrl: '',
    requests: [],
    reply: () => notFound,
    latencyMs: 0,
    pending: () => timers.size,
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
  const server: Server = createServer((req, res) => {
    const match = /^\/v1\/relaycast\/credential-tags\/([^/]+)$/.exec(req.url ?? '');
    if (!match || req.method !== 'GET') {
      res.writeHead(404).end();
      return;
    }
    const authorization = req.headers.authorization;
    fake.requests.push({ wsid: match[1]!, token: authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined });
    const reply = fake.reply(match[1]!);
    const answer = () => {
      timers.delete(timer);
      if (reply.body === undefined) {
        res.writeHead(reply.status).end();
      } else {
        res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body));
      }
    };
    const timer = setTimeout(answer, fake.latencyMs);
    timers.add(timer);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      fake.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve(fake);
    });
  });
}

describe('remote credential tagger', () => {
  let relayauth: FakeRelayAuth;
  let clock: number;
  beforeAll(async () => {
    relayauth = await startFakeRelayAuth();
  });
  afterAll(() => relayauth.close());
  beforeEach(() => {
    relayauth.requests.length = 0;
    relayauth.reply = () => ok();
    relayauth.latencyMs = 0;
    clock = 1_700_000_000_000;
  });
  const tagger = (options: Partial<RemoteCredentialTaggerOptions> = {}) =>
    remoteCredentialTagger({ baseUrl: `${relayauth.baseUrl}/`, token: TOKEN, now: () => clock, ...options });
  const requests = () => relayauth.requests.length;

  it('fetches tags once per workspace with the bearer token and serves tag/tags/verify from the cache', async () => {
    const remote = tagger();
    expect(await remote.tag(WS)).toBe(TAGS[0]);
    expect(await remote.tags(WS)).toEqual(TAGS);
    expect(await remote.verify(credential(TAGS[1]))).toBe(true);
    expect(await remote.verify(credential('aZZZ999yyy8'))).toBe(false);
    expect(relayauth.requests).toEqual([{ wsid: WSID, token: TOKEN }]);
  });

  it('shares one in-flight request among concurrent callers of a workspace', async () => {
    relayauth.latencyMs = 50;
    const remote = tagger();
    const answers = await Promise.all([
      ...Array.from({ length: 50 }, () => remote.verify(credential(TAGS[0]))),
      ...Array.from({ length: 50 }, () => remote.verify(credential('zZZZ999yyy8'))), // unknown version
      remote.tag(WS),
      remote.tags(WS),
    ]);
    expect(answers.slice(0, 50).every((answer) => answer === true)).toBe(true);
    expect(answers.slice(50, 100).every((answer) => answer === false)).toBe(true);
    expect(answers[100]).toBe(TAGS[0]);
    expect(answers[101]).toEqual(TAGS);
    // The first fetch, plus at most the single forced refetch the unknown versions earned.
    expect(requests()).toBeLessThanOrEqual(2);
  });

  it('refetches once for a tag under a version the cached list does not know, then not again inside the window', async () => {
    let served = TAGS.slice(0, 1);
    relayauth.reply = () => ok(served);
    const remote = tagger({ unknownVersionRefetchIntervalMs: 30_000 });

    expect(await remote.verify(credential(TAGS[0]))).toBe(true);
    // A rotation added version 'b' after the cache filled: one refetch picks it up.
    served = TAGS;
    expect(await remote.verify(credential(TAGS[1]))).toBe(true);
    expect(requests()).toBe(2);
    expect(await remote.verify(credential(TAGS[1]))).toBe(true);
    expect(requests()).toBe(2);

    // Further unknown letters inside the window are refused without a request.
    for (const letter of 'cdefghijklmnopqrstuvwxyz') {
      expect(await remote.verify(credential(`${letter}ZZZ999yyy8`))).toBe(false);
    }
    expect(requests()).toBe(2);
    // Past the window one more forced refetch is allowed.
    clock += 30_000;
    expect(await remote.verify(credential('cZZZ999yyy8'))).toBe(false);
    expect(requests()).toBe(3);
    expect(await remote.verify(credential('dZZZ999yyy8'))).toBe(false);
    expect(requests()).toBe(3);
  });

  it('refuses a forged tag under a known version without a second fetch', async () => {
    const remote = tagger();
    expect(await remote.verify(credential('aZZZ999yyy8'))).toBe(false);
    expect(requests()).toBe(1);
  });

  it('remembers a workspace RelayAuth never tagged for the negative TTL; tag() re-asks at once', async () => {
    let found = false;
    relayauth.reply = (wsid) => (found && wsid === WSID ? ok() : notFound);
    const remote = tagger({ negativeTtlMs: 30_000 });

    for (let i = 0; i < 50; i += 1) expect(await remote.verify(credential(TAGS[0]))).toBe(false);
    expect(await remote.tags(WS)).toEqual([]);
    expect(requests()).toBe(1);

    // A mint does not wait out the negative TTL: RelayAuth may have just tagged the workspace.
    await expect(remote.tag(WS)).rejects.toThrow(/no credential tag/);
    expect(requests()).toBe(2);
    found = true;
    expect(await remote.tag(WS)).toBe(TAGS[0]);
    expect(requests()).toBe(3);
    expect(await remote.verify(credential(TAGS[0]))).toBe(true);
    expect(requests()).toBe(3);

    // Another untagged workspace: verify re-asks only once the negative TTL has passed.
    const other = generateWorkspaceId();
    expect(await remote.verify(credential(TAGS[0], other))).toBe(false);
    clock += 29_999;
    expect(await remote.verify(credential(TAGS[0], other))).toBe(false);
    expect(requests()).toBe(4);
    clock += 1;
    expect(await remote.verify(credential(TAGS[0], other))).toBe(false);
    expect(requests()).toBe(5);
  });

  it('treats an empty tag list like a 404', async () => {
    relayauth.reply = () => ok([]);
    const remote = tagger();
    expect(await remote.tags(WS)).toEqual([]);
    expect(await remote.verify(credential(TAGS[0]))).toBe(false);
    await expect(remote.tag(WS)).rejects.toThrow(/no credential tag/);
  });

  it('fails closed when RelayAuth does not answer within the timeout, and does not cache the failure', async () => {
    relayauth.latencyMs = 500;
    const remote = tagger({ timeoutMs: 50 });
    const started = Date.now();
    await expect(remote.verify(credential(TAGS[0]))).rejects.toThrow(/no answer within 50 ms/);
    expect(Date.now() - started).toBeLessThan(400);
    await expect(remote.tag(WS)).rejects.toThrow(/no answer within 50 ms/);
    expect(requests()).toBe(2);
    relayauth.latencyMs = 0;
    expect(await remote.verify(credential(TAGS[0]))).toBe(true);
    expect(requests()).toBe(3);
  });

  it('revalidates a tag list after the TTL: a current change is minted under, a removed version stops verifying', async () => {
    let served: readonly string[] = TAGS;
    relayauth.reply = () => ok(served);
    const remote = tagger({ ttlMs: 300_000 });
    expect(await remote.tag(WS)).toBe(TAGS[0]);
    expect(await remote.verify(credential(TAGS[1]))).toBe(true);

    // RelayAuth makes 'b' current and drops 'a'. Inside the TTL nothing changes...
    served = [TAGS[1]!];
    clock += 299_999;
    expect(await remote.tag(WS)).toBe(TAGS[0]);
    expect(await remote.verify(credential(TAGS[0]))).toBe(true);
    expect(requests()).toBe(1);
    // ...and the first use past it awaits one revalidation.
    clock += 1;
    expect(await remote.tag(WS)).toBe(TAGS[1]);
    expect(await remote.tags(WS)).toEqual([TAGS[1]]);
    expect(requests()).toBe(2);
    // The dropped version is now an unknown letter: one forced refetch, then refused outright.
    expect(await remote.verify(credential(TAGS[0]))).toBe(false);
    expect(requests()).toBe(3);
    expect(await remote.verify(credential(TAGS[0]))).toBe(false);
    expect(await remote.verify(credential(TAGS[1]))).toBe(true);
    expect(requests()).toBe(3);
  });

  it('shares one revalidation among concurrent callers, and keeps the stale list when it fails', async () => {
    relayauth.reply = () => ok();
    const remote = tagger({ ttlMs: 1_000 });
    expect(await remote.tags(WS)).toEqual(TAGS);
    clock += 1_000;
    relayauth.latencyMs = 50;
    const answers = await Promise.all(Array.from({ length: 20 }, () => remote.verify(credential(TAGS[0]))));
    expect(answers.every((answer) => answer === true)).toBe(true);
    expect(requests()).toBe(2);

    // RelayAuth fails during the next revalidation: the call fails closed, the
    // failure is not cached, and the next call tries again.
    relayauth.latencyMs = 0;
    relayauth.reply = () => ({ status: 503 });
    clock += 1_000;
    await expect(remote.verify(credential(TAGS[0]))).rejects.toThrow(/HTTP 503/);
    relayauth.reply = () => ok();
    expect(await remote.verify(credential(TAGS[0]))).toBe(true);
    expect(requests()).toBe(4);
  });

  it('refuses non-ar_ credentials', async () => {
    const remote = tagger();
    expect(await remote.verify(`rk_live_${'0'.repeat(32)}`)).toBe(false);
    expect(requests()).toBe(0);
  });

  it('fails closed on RelayAuth errors and malformed bodies, and never caches them', async () => {
    for (const reply of [
      { status: 500 } as Reply,
      { status: 200, body: { ok: false, error: { code: 'nope' } } },
      { status: 200, body: { ok: true, data: { tags: 'not-an-array' } } },
      { status: 200, body: { ok: true, data: { tags: ['not a tag shape'] } } },
    ]) {
      relayauth.reply = () => reply;
      relayauth.requests.length = 0;
      const remote = tagger();
      await expect(remote.tags(WS)).rejects.toThrow();
      await expect(remote.verify(credential(TAGS[0]))).rejects.toThrow();
      expect(requests()).toBe(2);
      relayauth.reply = () => ok();
      expect(await remote.verify(credential(TAGS[0]))).toBe(true);
    }
    const down = remoteCredentialTagger({ baseUrl: 'http://127.0.0.1:1', token: TOKEN });
    await expect(down.tags(WS)).rejects.toThrow();
  });

  it('bounds the per-workspace cache, evicting the least recently used entry', async () => {
    const remote = tagger({ maxCachedWorkspaces: 2 });
    const workspaces = [generateWorkspaceId(), generateWorkspaceId(), generateWorkspaceId()];
    await remote.tags(workspaces[0]!);
    await remote.tags(workspaces[1]!);
    await remote.tags(workspaces[0]!); // refresh workspaces[0]; workspaces[1] is now oldest
    await remote.tags(workspaces[2]!); // evicts workspaces[1]
    expect(requests()).toBe(3);
    await remote.tags(workspaces[0]!); // still cached
    expect(requests()).toBe(3);
    await remote.tags(workspaces[1]!); // evicted, fetched again
    expect(requests()).toBe(4);
  });

  it('rejects a base URL that is not http(s)', () => {
    expect(() => remoteCredentialTagger({ baseUrl: 'not a url', token: 't' })).toThrow();
    expect(() => remoteCredentialTagger({ baseUrl: 'ftp://relayauth.test', token: 't' })).toThrow();
  });

  describe('a workspace RelayAuth has not tagged', () => {
    const headers = (token: string, idempotencyKey?: string) => ({
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    });

    it('has no ar derivation family', async () => {
      relayauth.reply = () => notFound;
      const stack = makeNodeStack({ credentialTagger: tagger() });
      expect(await derivationFamilies(stack.runtime.deps.db, WS)).toEqual([{ format: 'legacy' }]);
      expect(requests()).toBe(1);
    });

    it('does not fail a keyed POST /v1/workspaces replay', async () => {
      relayauth.reply = () => notFound;
      const stack = makeNodeStack({ credentialTagger: tagger() });
      const owner = await createWorkspace(stack.app, 'owner');
      const create = () => stack.app.request('/v1/workspaces', {
        method: 'POST',
        headers: headers(owner.workspaceKey, 'owner-create-0123456789abcdef'),
        body: JSON.stringify({ name: 'child' }),
      });
      const first = await create();
      expect(first.status).toBe(201);
      const replay = await create();
      expect(replay.status).toBe(200);
      const key = async (res: Response) => ((await res.json()) as { data: { api_key?: string; key?: string } }).data;
      expect(await key(replay)).toEqual(await key(first));
      expect(requests()).toBeGreaterThan(0);
    });

    it('does not fail an Idempotency-Key node token rotation', async () => {
      relayauth.reply = () => notFound;
      const stack = makeNodeStack({ credentialTagger: tagger() });
      const workspace = await createWorkspace(stack.app, 'node-rotation');
      const enroll = async (body: Record<string, unknown>, nodeToken?: string, idempotencyKey?: string) => {
        const res = await stack.app.request('/v1/nodes', {
          method: 'POST',
          headers: {
            ...headers(workspace.workspaceKey, idempotencyKey),
            ...(nodeToken ? { 'x-relaycast-node-token': nodeToken } : {}),
          },
          body: JSON.stringify(body),
        });
        return { status: res.status, token: ((await res.json()) as { data?: { token: string } }).data?.token };
      };
      const first = await enroll({ node_id: 'node_a', name: 'host' });
      expect(first.status).toBe(201);
      const request = { node_id: 'node_a', name: 'host', version: 'v2' };
      const key = 'node-rotation-00000000-0000-4000-8000-00000000000a';
      const rotated = await enroll(request, first.token, key);
      expect(rotated.status).toBe(201);
      expect(rotated.token).toMatch(/^nt_live_/);
      const recovered = await enroll(request, first.token, key);
      expect(recovered).toEqual({ status: 201, token: rotated.token });
      const rows = await stack.runtime.deps.db.select({ tokenHash: nodes.tokenHash }).from(nodes).where(eq(nodes.id, 'node_a'));
      expect(rows).toEqual([{ tokenHash: await sha256Hex(rotated.token!) }]);
      expect(requests()).toBeGreaterThan(0);
    });
  });
});
