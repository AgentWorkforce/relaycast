import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CloudWorkspaceRegistry,
  InMemoryWorkspaceRegistryStore,
  LocalWorkspaceRegistry,
} from '../../packages/core/src/workspace/registry.js';
import {
  generateWorkspaceId,
  isValidWorkspaceId,
} from '../../packages/core/src/workspace/id.js';
import {
  isValidWorkspaceIdAny,
} from '../../packages/core/src/workspace-id.js';

type TokenClaims = {
  aud: string | string[];
  workspace?: string;
  workspace_id: string;
  wks: string;
  agent_name: string;
  agentName: string;
  scopes: string[];
};

const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function stubRelayAuth(accessToken: string): Array<{ url: string; init?: RequestInit }> {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/v1/identities')) {
      return new Response(JSON.stringify({ id: 'id_test' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/v1/tokens')) {
      return new Response(JSON.stringify({ accessToken }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  };
  return calls;
}

describe('workspace ID helpers', () => {
  it('generates rw_ IDs and preserves legacy validation compatibility', () => {
    const first = generateWorkspaceId();
    const second = generateWorkspaceId();

    assert.match(first, /^rw_[a-f0-9]{8}$/);
    assert.match(second, /^rw_[a-f0-9]{8}$/);
    assert.notEqual(first, second);
    assert.equal(isValidWorkspaceId(first), true);
    assert.equal(isValidWorkspaceIdAny(first), true);
    assert.equal(isValidWorkspaceIdAny('wf-abc123'), true);
    assert.equal(isValidWorkspaceId('wf-abc123'), false);
  });
});

describe('CloudWorkspaceRegistry', () => {
  it('creates, stores, and joins a unified workspace mapping', async () => {
    const relayAuthCalls = stubRelayAuth('relayauth-join-token');
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      fetchCalls.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          workspace_id: 'relaycast_123',
          api_key: 'rk_live_test_cloud',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    };

    const registry = new CloudWorkspaceRegistry(
      'https://relaycast.test',
      'https://relayfile.test',
      'cloud-relayauth-api-key',
      {
        fetchImpl,
        persistence: new InMemoryWorkspaceRegistryStore(),
        now: () => new Date('2026-03-27T12:00:00.000Z'),
      },
    );

    const entry = await registry.create({
      name: 'project-alpha',
      createdBy: 'user_123',
    });
    const stored = await registry.get(entry.id);
    const joined = await registry.join(entry.id, 'worker-agent');

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0]?.url, 'https://relaycast.test/v1/workspaces');
    assert.deepEqual(JSON.parse(String(fetchCalls[0]?.init?.body)), {
      name: 'project-alpha',
    });
    assert.match(entry.id, /^rw_[a-f0-9]{8}$/);
    assert.deepEqual(stored, entry);
    assert.equal(entry.relaycastApiKey, 'rk_live_test_cloud');
    assert.equal(entry.relayfileWorkspaceId, entry.id);
    assert.equal(entry.relayauthWorkspaceId, entry.id);
    assert.equal(entry.createdAt, '2026-03-27T12:00:00.000Z');
    assert.equal(joined.entry.id, entry.id);
    assert.equal(joined.token, 'relayauth-join-token');
    assert.equal(relayAuthCalls.length, 2);
    // ops:read + sync:trigger are part of DEFAULT_JOIN_SCOPES per the
    // writeback-reliability spec (PR #448) — wizard-issued tokens carry
    // them so agents can introspect the writeback pipeline via
    // `relayfile pull` and `relayfile ops list`.
    assert.deepEqual(JSON.parse(String(relayAuthCalls[1]?.init?.body)), {
      identityId: 'id_test',
      scopes: ['fs:read', 'fs:write', 'ops:read', 'sync:read', 'sync:trigger'],
      audience: ['relayfile'],
      expiresIn: 7200,
    });
  });
});

describe('LocalWorkspaceRegistry', () => {
  it('persists local workspace mappings to .relay/workspaces.json and mints join tokens', async () => {
    stubRelayAuth('local-relayauth-token');
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'workspace-registry-'));
    tempDirs.push(rootDir);

    const registry = new LocalWorkspaceRegistry({
      rootDir,
      relayauthApiKey: 'local-relayauth-api-key',
      now: () => new Date('2026-03-27T13:00:00.000Z'),
    });

    const entry = await registry.create({
      name: 'local-project',
      createdBy: 'org_456',
    });
    const joined = await registry.join(entry.id, 'local-agent');
    const stored = JSON.parse(
      await readFile(path.join(rootDir, '.relay', 'workspaces.json'), 'utf8'),
    ) as {
      workspaces: Record<string, {
        createdBy: string;
        relaycastApiKey: string;
      }>;
    };

    assert.equal(entry.relaycastApiKey, '');
    assert.deepEqual(stored.workspaces[entry.id]?.createdBy, 'org_456');
    assert.deepEqual(stored.workspaces[entry.id]?.relaycastApiKey, '');
    assert.equal(joined.entry.id, entry.id);
    assert.equal(joined.token, 'local-relayauth-token');
  });
});

function decodeToken(token: string): TokenClaims {
  const parts = token.split('.');
  assert.equal(parts.length, 3);
  const payload = parts[1]
    ?.replace(/-/g, '+')
    .replace(/_/g, '/');
  assert.ok(payload);
  const pad = (4 - (payload.length % 4)) % 4;
  return JSON.parse(
    Buffer.from(payload + '='.repeat(pad), 'base64').toString('utf8'),
  ) as TokenClaims;
}
