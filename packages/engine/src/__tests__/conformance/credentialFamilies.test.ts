import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { encodeArCredential, parseCredential } from '@relaycast/types';
import { agents, credentialUpgrades, nodes, webhooks, workspaces } from '../../db/schema.js';
import { upgradeLegacyCredential } from '../../engine/credentialUpgrade.js';
import { hmacSha256Hex, sha256Hex } from '../../lib/crypto.js';
import { SqliteApiKeyAuthProvider } from '../../auth/index.js';
import { createCredentialTagSigner } from '../../auth/credentialTags.js';
import type { EngineObservation } from '../../ports/telemetry.js';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';
import type { CredentialTagger } from '../../auth/credentialTags.js';

const tagger = createCredentialTagSigner({ current: 'a', keys: { a: 'credential-tag-secret-a' } });
const SECRET = Uint8Array.from({ length: 32 }, (_, i) => i + 3);
const AR = (kind: 'agent' | 'workspace', workspaceId: string) =>
  encodeArCredential({ kind, workspaceId, tag: 'aAAAAAAAAAA', secret: SECRET });

function get(stack: TestStack, path: string, token: string): Promise<Response> {
  return stack.app.request(path, { headers: { authorization: `Bearer ${token}` } });
}

function upgrade(stack: TestStack, token: string): Promise<Response> {
  return stack.app.request('/v1/credentials/upgrade', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
}

async function upgraded(stack: TestStack, token: string): Promise<{ credential: string; kind: string; legacy_expires_at: string }> {
  const res = await upgrade(stack, token);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { credential: string; kind: string; legacy_expires_at: string } }).data;
}

/** Give an existing agent `token` as its credential (no deployment mints the other family). */
async function setAgentToken(stack: TestStack, agentId: string, token: string): Promise<void> {
  await stack.runtime.deps.db.update(agents).set({ tokenHash: await sha256Hex(token) }).where(eq(agents.id, agentId));
}

describe('credential families', () => {
  it('a legacy-minting deployment mints legacy credentials and verifies both families', async () => {
    const stack = makeNodeStack();
    const workspace = await createWorkspace(stack.app, 'legacy-mint');
    const agent = await registerAgent(stack.app, workspace.workspaceKey, 'alice');
    expect(workspace.workspaceKey).toMatch(/^rk_live_[0-9a-f]{32}$/);
    expect(agent.token).toMatch(/^at_live_[0-9a-f]{32}$/);
    expect((await get(stack, '/v1/inbox', agent.token)).status).toBe(200);

    const ar = AR('agent', workspace.workspaceId);
    await setAgentToken(stack, agent.agentId, ar);
    expect((await get(stack, '/v1/inbox', ar)).status).toBe(200);
    expect((await get(stack, '/v1/inbox', agent.token)).status).toBe(401);
  });

  it('an ar-minting deployment mints tagged ar_ credentials and verifies both families', async () => {
    const stack = makeNodeStack({ credentialFormat: 'ar', credentialTagger: tagger });
    const workspace = await createWorkspace(stack.app, 'ar-mint');
    const agent = await registerAgent(stack.app, workspace.workspaceKey, 'alice');
    expect(workspace.workspaceKey).toMatch(/^ar_ws_[0-9A-Za-z]{11}_a[0-9A-Za-z]{10}_[0-9A-Za-z]{49}$/);
    expect(agent.token).toMatch(/^ar_ag_/);
    expect(await tagger.verify(workspace.workspaceKey)).toBe(true);
    expect(await tagger.verify(agent.token)).toBe(true);
    expect((await get(stack, '/v1/agents', workspace.workspaceKey)).status).toBe(200);
    expect((await get(stack, '/v1/inbox', agent.token)).status).toBe(200);

    const legacy = `at_live_${'cd'.repeat(16)}`;
    await setAgentToken(stack, agent.agentId, legacy);
    expect((await get(stack, '/v1/inbox', legacy)).status).toBe(200);
  });

  it('refuses an ar-minting deployment without a tagger', () => {
    expect(() => makeNodeStack({ credentialFormat: 'ar' })).toThrow(/credentialTagger/);
  });

  it('rejects an ar_ credential of the wrong kind or naming another workspace', async () => {
    const stack = makeNodeStack();
    const a = await createWorkspace(stack.app, 'scope-a');
    const b = await createWorkspace(stack.app, 'scope-b');
    const agentB = await registerAgent(stack.app, b.workspaceKey, 'bob');

    // B's agent holds a credential that names workspace A.
    const namesA = AR('agent', a.workspaceId);
    await setAgentToken(stack, agentB.agentId, namesA);
    expect((await get(stack, '/v1/inbox', namesA)).status).toBe(401);

    const namesB = AR('agent', b.workspaceId);
    await setAgentToken(stack, agentB.agentId, namesB);
    expect((await get(stack, '/v1/inbox', namesB)).status).toBe(200);
    // The right workspace, but presented as a workspace key: the workspaces table holds no such hash.
    const wrongKind = AR('workspace', b.workspaceId);
    await setAgentToken(stack, agentB.agentId, wrongKind);
    expect((await get(stack, '/v1/agents', wrongKind)).status).toBe(401);
    expect((await get(stack, '/v1/inbox', wrongKind)).status).toBe(401);
  });

  it('verifies an ar_ credential with a single query', async () => {
    const stack = makeNodeStack({ credentialFormat: 'ar', credentialTagger: tagger });
    const workspace = await createWorkspace(stack.app, 'one-query');
    const agent = await registerAgent(stack.app, workspace.workspaceKey, 'alice');
    const { db } = stack.runtime.deps;
    const auth = new SqliteApiKeyAuthProvider();
    const prepare = vi.spyOn(stack.runtime.handle.sqlite, 'prepare');

    for (const [token, require] of [[workspace.workspaceKey, 'workspace'], [agent.token, 'agent']] as const) {
      prepare.mockClear();
      const result = await auth.authenticate({ token, require, db });
      expect(result.ok).toBe(true);
      expect(prepare).toHaveBeenCalledTimes(1);
    }

    prepare.mockClear();
    const unknown = await auth.authenticate({ token: AR('agent', workspace.workspaceId), require: 'agent', db });
    expect(unknown.ok).toBe(false);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('authenticates ar_ observer tokens as observers with their scopes', async () => {
    const stack = makeNodeStack({ credentialFormat: 'ar', credentialTagger: tagger });
    const workspace = await createWorkspace(stack.app, 'observer-scope');
    const created = await stack.app.request('/v1/observer-tokens', {
      method: 'POST',
      headers: { authorization: `Bearer ${workspace.workspaceKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'stream-only', scopes: ['stream:read'] }),
    });
    expect(created.status).toBe(201);
    const { data } = await created.json() as { data: { token: string } };
    expect(data.token).toMatch(/^ar_ob_/);
    // A read route requiring files:read refuses the stream-only token.
    const files = await get(stack, '/v1/files', data.token);
    expect(files.status).toBe(403);
    expect(((await files.json()) as { error: { code: string } }).error.code).toBe('insufficient_scope');
  });
});

describe('POST /v1/credentials/upgrade', () => {
  it('exchanges a legacy credential for an ar_ one for the same principal, idempotently', async () => {
    const stack = makeNodeStack({ credentialTagger: tagger });
    const workspace = await createWorkspace(stack.app, 'upgrade');
    const agent = await registerAgent(stack.app, workspace.workspaceKey, 'alice');

    for (const [legacy, kind, code, probe] of [
      [agent.token, 'agent', 'ag', '/v1/inbox'],
      [workspace.workspaceKey, 'workspace', 'ws', '/v1/agents'],
    ] as const) {
      const first = await upgraded(stack, legacy);
      expect(first.kind).toBe(kind);
      expect(first.credential).toMatch(new RegExp(`^ar_${code}_`));
      expect(await tagger.verify(first.credential)).toBe(true);
      // The default grace covers a 30-day sunset.
      expect(Date.parse(first.legacy_expires_at) - Date.now()).toBeGreaterThan(29 * 24 * 3600 * 1000);

      // Both work during the grace, and upgrading again returns the same ar_ credential.
      expect((await get(stack, probe, first.credential)).status).toBe(200);
      expect((await get(stack, probe, legacy)).status).toBe(200);
      expect((await upgraded(stack, legacy)).credential).toBe(first.credential);

      const already = await upgrade(stack, first.credential);
      expect(already.status).toBe(409);
      expect(((await already.json()) as { error: { code: string } }).error.code).toBe('credential_not_legacy');
    }
  });

  it('ends the legacy credential when its grace runs out', async () => {
    const stack = makeNodeStack({ credentialTagger: tagger, legacyCredentialGraceSeconds: 60 });
    const workspace = await createWorkspace(stack.app, 'grace');
    const agent = await registerAgent(stack.app, workspace.workspaceKey, 'alice');
    const { credential, legacy_expires_at } = await upgraded(stack, agent.token);
    expect(Math.abs(Date.parse(legacy_expires_at) - (Date.now() + 60_000))).toBeLessThan(2_000);
    expect((await get(stack, '/v1/inbox', agent.token)).status).toBe(200);

    await stack.runtime.deps.db.update(credentialUpgrades).set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(credentialUpgrades.legacyHash, await sha256Hex(agent.token)));
    expect((await get(stack, '/v1/inbox', agent.token)).status).toBe(401);
    expect((await get(stack, '/v1/inbox', credential)).status).toBe(200);
  });

  it('ends the legacy credential when the principal moves off its ar_ credential', async () => {
    const stack = makeNodeStack({ credentialTagger: tagger });
    const workspace = await createWorkspace(stack.app, 'rotated');
    const agent = await registerAgent(stack.app, workspace.workspaceKey, 'alice');
    await upgraded(stack, agent.token);
    await setAgentToken(stack, agent.agentId, AR('agent', workspace.workspaceId));
    expect((await get(stack, '/v1/inbox', agent.token)).status).toBe(401);
  });

  it('upgrades observer and inbound webhook credentials', async () => {
    const stack = makeNodeStack({ credentialTagger: tagger });
    const workspace = await createWorkspace(stack.app, 'kinds');
    const post = async (path: string, body: unknown) => ((await (await stack.app.request(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${workspace.workspaceKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })).json()) as { data: Record<string, string> }).data;

    const observer = (await post('/v1/observer-tokens', { name: 'obs', scopes: ['files:read'] })).token;
    const observerAr = (await upgraded(stack, observer)).credential;
    expect(observerAr).toMatch(/^ar_ob_/);
    expect((await get(stack, '/v1/files', observerAr)).status).toBe(200);
    expect((await get(stack, '/v1/files', observer)).status).toBe(200);

    await post('/v1/channels', { name: 'hooks' });
    const hook = await post('/v1/webhooks', { name: 'hook', channel: 'hooks' });
    expect(hook.token).toMatch(/^wh_live_/);
    const hookAr = (await upgraded(stack, hook.token)).credential;
    expect(hookAr).toMatch(/^ar_wh_/);
    for (const token of [hookAr, hook.token]) {
      const sent = await stack.app.request(`/v1/hooks/${hook.webhook_id}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      });
      expect(sent.status).toBeLessThan(300);
    }
  });

  it('writes no grace record when a rotation lands between authentication and the swap', async () => {
    const stack = makeNodeStack({ credentialTagger: tagger });
    const workspace = await createWorkspace(stack.app, 'race-rotation');
    const agent = await registerAgent(stack.app, workspace.workspaceKey, 'alice');
    const { db } = stack.runtime.deps;
    const legacyHash = await sha256Hex(agent.token);
    // Authenticated with the legacy token (currentHash), then a rotation commits.
    const rotated = AR('agent', workspace.workspaceId);
    await setAgentToken(stack, agent.agentId, rotated);

    await expect(upgradeLegacyCredential(db, {
      legacyToken: agent.token,
      kind: 'agent',
      principalId: agent.agentId,
      workspaceId: workspace.workspaceId,
      currentHash: legacyHash,
      graceSeconds: 60,
    })).rejects.toMatchObject({ code: 'credential_superseded', status: 409 });
    expect(await db.select().from(credentialUpgrades)).toEqual([]);
    const [row] = await db.select({ tokenHash: agents.tokenHash }).from(agents).where(eq(agents.id, agent.agentId));
    expect(row.tokenHash).toBe(await sha256Hex(rotated));
    expect((await get(stack, '/v1/inbox', agent.token)).status).toBe(401);
    expect((await get(stack, '/v1/inbox', rotated)).status).toBe(200);
  });

  it('settles concurrent upgrades of one credential on one ar_ credential and one grace record', async () => {
    const stack = makeNodeStack({ credentialTagger: tagger });
    const workspace = await createWorkspace(stack.app, 'race-upgrade');
    const agent = await registerAgent(stack.app, workspace.workspaceKey, 'alice');
    const results = await Promise.all([upgrade(stack, agent.token), upgrade(stack, agent.token), upgrade(stack, agent.token)]);
    const credentials = new Set<string>();
    for (const res of results) {
      expect(res.status).toBe(200);
      credentials.add(((await res.json()) as { data: { credential: string } }).data.credential);
    }
    expect(credentials.size).toBe(1);
    expect(await stack.runtime.deps.db.select().from(credentialUpgrades)).toHaveLength(1);
    expect((await get(stack, '/v1/inbox', [...credentials][0])).status).toBe(200);
    expect((await get(stack, '/v1/inbox', agent.token)).status).toBe(200);
  });

  it('refuses to upgrade a webhook token of an expired workspace', async () => {
    const stack = makeNodeStack({ credentialTagger: tagger });
    const workspace = await createWorkspace(stack.app, 'expired-hook');
    const post = async (path: string, body: unknown) => ((await (await stack.app.request(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${workspace.workspaceKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })).json()) as { data: Record<string, string> }).data;
    await post('/v1/channels', { name: 'hooks' });
    const hook = await post('/v1/webhooks', { name: 'hook', channel: 'hooks' });
    await stack.runtime.deps.db.update(workspaces).set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(workspaces.id, workspace.workspaceId));
    const res = await upgrade(stack, hook.token);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('workspace_expired');
    expect(await stack.runtime.deps.db.select().from(credentialUpgrades)).toEqual([]);
  });

  it('issues a random ar_ credential that the legacy credential and public inputs cannot rebuild', async () => {
    const stack = makeNodeStack({ credentialTagger: tagger });
    const workspace = await createWorkspace(stack.app, 'not-derivable');
    const agent = await registerAgent(stack.app, workspace.workspaceKey, 'alice');
    const { credential } = await upgraded(stack, agent.token);
    const { tag } = parseCredential(credential) as { tag: string };
    // Everything an outsider holding the legacy credential knows: the token,
    // kind, principal and workspace ids, and the tag of any ar_ credential.
    for (const context of [
      `relaycast:credential-upgrade:v1:agent:${agent.agentId}`,
      `relaycast:credential-upgrade:v1:agent:${agent.agentId}:${tag}`,
      `${agent.agentId}:${workspace.workspaceId}:${tag}`,
    ]) {
      const digest = await hmacSha256Hex(context, agent.token);
      const rebuilt = encodeArCredential({
        kind: 'agent', workspaceId: workspace.workspaceId, tag,
        secret: Uint8Array.from(digest.match(/../g)!.map((byte) => Number.parseInt(byte, 16))),
      });
      expect(rebuilt).not.toBe(credential);
      expect((await get(stack, '/v1/inbox', rebuilt)).status).toBe(401);
    }
    // Upgrading again still returns the issued credential, from the server's record.
    expect((await upgraded(stack, agent.token)).credential).toBe(credential);
  });

  it('refuses to hand back an ar_ credential the principal has rotated away from', async () => {
    const stack = makeNodeStack({ credentialTagger: tagger });
    const workspace = await createWorkspace(stack.app, 'rotated-ar');
    const agent = await registerAgent(stack.app, workspace.workspaceKey, 'alice');
    const { credential } = await upgraded(stack, agent.token);
    await setAgentToken(stack, agent.agentId, AR('agent', workspace.workspaceId));
    expect((await get(stack, '/v1/inbox', credential)).status).toBe(401);
    expect((await upgrade(stack, agent.token)).status).toBe(401);
  });

  it('returns the credential of a successful swap even with a zero grace', async () => {
    const stack = makeNodeStack({ credentialTagger: tagger, legacyCredentialGraceSeconds: 0 });
    const workspace = await createWorkspace(stack.app, 'zero-grace');
    const agent = await registerAgent(stack.app, workspace.workspaceKey, 'alice');
    const { credential } = await upgraded(stack, agent.token);
    expect((await get(stack, '/v1/inbox', credential)).status).toBe(200);
    expect((await get(stack, '/v1/inbox', agent.token)).status).toBe(401);
    // A retry after the grace: the legacy credential no longer authenticates.
    expect((await upgrade(stack, agent.token)).status).toBe(401);
    expect(await stack.runtime.deps.db.select().from(credentialUpgrades)).toHaveLength(1);
  });

  it('tells a retry after the grace to use or rotate the ar_ credential', async () => {
    const stack = makeNodeStack({ credentialTagger: tagger });
    const workspace = await createWorkspace(stack.app, 'after-grace');
    const agent = await registerAgent(stack.app, workspace.workspaceKey, 'alice');
    const { credential } = await upgraded(stack, agent.token);
    const { db } = stack.runtime.deps;
    await db.update(credentialUpgrades).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await upgrade(stack, agent.token)).status).toBe(401);
    await expect(upgradeLegacyCredential(db, {
      legacyToken: agent.token,
      kind: 'agent',
      principalId: agent.agentId,
      workspaceId: workspace.workspaceId,
      currentHash: await sha256Hex(credential),
      graceSeconds: 60,
    })).rejects.toMatchObject({ code: 'credential_grace_expired', status: 401 });
  });

  it('is unavailable without a tagger', async () => {
    const stack = makeNodeStack();
    const workspace = await createWorkspace(stack.app, 'no-tagger');
    const res = await upgrade(stack, workspace.workspaceKey);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('credential_upgrade_unavailable');
  });
});

describe('legacy credential deprecation', () => {
  it('marks only legacy-authenticated responses deprecated, with the configured sunset', async () => {
    const sunset = new Date('2026-12-31T00:00:00Z');
    const stack = makeNodeStack({ credentialTagger: tagger, legacyCredentialSunset: sunset });
    const workspace = await createWorkspace(stack.app, 'deprecation');
    const legacy = await get(stack, '/v1/agents', workspace.workspaceKey);
    expect(legacy.status).toBe(200);
    expect(legacy.headers.get('Deprecation')).toBe('@1793318400');
    expect(legacy.headers.get('Sunset')).toBe(sunset.toUTCString());
    expect(legacy.headers.get('Link')).toContain('rel="deprecation"');

    const { credential } = await upgraded(stack, workspace.workspaceKey);
    const ar = await get(stack, '/v1/agents', credential);
    expect(ar.status).toBe(200);
    expect(ar.headers.get('Deprecation')).toBeNull();
    expect(ar.headers.get('Sunset')).toBeNull();
    expect(ar.headers.get('Link')).toBeNull();
  });
});

describe('legacy deprecation on every authenticated response', () => {
  const deprecated = (res: Response) => res.headers.get('Deprecation') === '@1793318400' && (res.headers.get('Link') ?? '').includes('deprecation');

  it('marks a 403 for a legacy observer token missing a scope', async () => {
    const stack = makeNodeStack();
    const workspace = await createWorkspace(stack.app, 'forbidden');
    const created = await stack.app.request('/v1/observer-tokens', {
      method: 'POST',
      headers: { authorization: `Bearer ${workspace.workspaceKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'stream-only', scopes: ['stream:read'] }),
    });
    const { data } = await created.json() as { data: { token: string } };
    const res = await get(stack, '/v1/files', data.token);
    expect(res.status).toBe(403);
    expect(deprecated(res)).toBe(true);
  });

  it('marks a 429 and an unavailable upgrade for a legacy credential', async () => {
    const stack = makeNodeStack();
    const workspace = await createWorkspace(stack.app, 'throttled');
    const statuses: number[] = [];
    let last: Response | undefined;
    for (let i = 0; i < 11; i += 1) {
      last = await upgrade(stack, workspace.workspaceKey);
      statuses.push(last.status);
      expect(deprecated(last)).toBe(true);
    }
    expect(statuses.slice(0, 10).every((status) => status === 409)).toBe(true);
    expect(last!.status).toBe(429);
  });
});

describe('owner-authenticated workspace create', () => {
  it('marks a legacy owner key deprecated and reports it', async () => {
    const events: EngineObservation[] = [];
    const stack = makeNodeStack({
      credentialTagger: tagger,
      telemetry: { capture: (event) => { events.push(event); }, captureException() {} },
    });
    const owner = await createWorkspace(stack.app, 'owner');
    events.length = 0;
    const res = await stack.app.request('/v1/workspaces', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${owner.workspaceKey}`,
        'content-type': 'application/json',
        'idempotency-key': 'owner-create-0123456789abcdef',
      },
      body: JSON.stringify({ name: 'child' }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('Deprecation')).toBe('@1793318400');
    expect(events.filter((event) => event.kind === 'request.authenticated')
      .map((event) => [event.facts.credential_family, event.workspaceId])).toEqual([['legacy', owner.workspaceId]]);
  });
});

describe('credential telemetry', () => {
  it('reports the family, kind, client and workspace of every authenticated request', async () => {
    const events: EngineObservation[] = [];
    const stack = makeNodeStack({
      credentialFormat: 'ar',
      credentialTagger: tagger,
      telemetry: { capture: (event) => { events.push(event); }, captureException() {} },
    });
    const workspace = await createWorkspace(stack.app, 'telemetry');
    const agent = await registerAgent(stack.app, workspace.workspaceKey, 'alice');
    const legacy = `at_live_${'ef'.repeat(16)}`;
    await setAgentToken(stack, agent.agentId, legacy);
    events.length = 0;
    await stack.app.request('/v1/inbox', {
      headers: {
        authorization: `Bearer ${legacy}`,
        'x-relaycast-origin-client': '@relaycast/sdk',
        'x-relaycast-origin-version': '12.3.0',
      },
    });
    await get(stack, '/v1/agents', workspace.workspaceKey);
    const authenticated = events.filter((event) => event.kind === 'request.authenticated');
    expect(authenticated.map((event) => [event.facts.credential_family, event.facts.credential_kind, event.workspaceId]))
      .toEqual([
        ['legacy', 'agent', workspace.workspaceId],
        ['ar', 'workspace', workspace.workspaceId],
      ]);
    expect(authenticated[0].origin).toMatchObject({ client: '@relaycast/sdk', version: '12.3.0' });
    // The event names the authenticated agent and the credential it presented.
    expect(authenticated[0].authenticatedActor).toMatchObject({ agentId: agent.agentId, credentialHash: await sha256Hex(legacy) });
  });
});

describe('ar_ node token rotation replay across a keyring rotation', () => {
  it('recovers the token the first attempt committed under the earlier tag', async () => {
    const keys = { a: 'credential-tag-secret-a', b: 'credential-tag-secret-b' };
    let signer = createCredentialTagSigner({ current: 'a', keys: { a: keys.a } });
    const rotating: CredentialTagger = { tag: (id) => signer.tag(id), tags: (id) => signer.tags(id) };
    const stack = makeNodeStack({ credentialFormat: 'ar', credentialTagger: rotating });
    const workspace = await createWorkspace(stack.app, 'node-replay');
    const enroll = async (body: Record<string, unknown>, nodeToken?: string, idempotencyKey?: string) => {
      const res = await stack.app.request('/v1/nodes', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${workspace.workspaceKey}`,
          ...(nodeToken ? { 'x-relaycast-node-token': nodeToken } : {}),
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: JSON.stringify(body),
      });
      return { status: res.status, token: ((await res.json()) as { data?: { token: string } }).data?.token };
    };
    const first = await enroll({ node_id: 'node_a', name: 'host' });
    const request = { node_id: 'node_a', name: 'host', version: 'v2' };
    const key = 'node-rotation-00000000-0000-4000-8000-00000000000a';
    const rotated = await enroll(request, first.token, key);
    expect(rotated.status).toBe(201);
    expect(rotated.token).toMatch(/^ar_nd_[0-9A-Za-z]{11}_a/);

    // The keyring rotates to `b` before the caller, who lost the response, retries.
    signer = createCredentialTagSigner({ current: 'b', keys });
    const recovered = await enroll(request, first.token, key);
    expect(recovered).toEqual({ status: 201, token: rotated.token });
    const rows = await stack.runtime.deps.db.select({ tokenHash: nodes.tokenHash }).from(nodes).where(eq(nodes.id, 'node_a'));
    expect(rows).toEqual([{ tokenHash: await sha256Hex(rotated.token!) }]);
  });
});

describe('inbound webhook credential notices', () => {
  it('note only a bearer token the webhook verified', async () => {
    const events: EngineObservation[] = [];
    const stack = makeNodeStack({ telemetry: { capture: (event) => { events.push(event); }, captureException() {} } });
    const workspace = await createWorkspace(stack.app, 'tokenless-hook');
    const post = async (path: string, body: unknown) => ((await (await stack.app.request(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${workspace.workspaceKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })).json()) as { data: Record<string, string> }).data;
    await post('/v1/channels', { name: 'hooks' });
    const hook = await post('/v1/webhooks', { name: 'hook', channel: 'hooks' });
    await stack.runtime.deps.db.update(webhooks).set({ tokenHash: null }).where(eq(webhooks.id, hook.webhook_id));
    events.length = 0;
    const res = await stack.app.request(`/v1/hooks/${hook.webhook_id}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${workspace.workspaceKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'unauthenticated' }),
    });
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get('Deprecation')).toBeNull();
    expect(events.filter((event) => event.kind === 'request.authenticated')).toEqual([]);
  });
});
