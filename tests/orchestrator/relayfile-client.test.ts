import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compilePermissionsToScopes,
  mintPathScopedRelayfileToken,
  mintRelayfileToken,
  mintScopedRelayfileToken,
  mintWorkspaceApiKey,
  mintWorkspacePathScopedRelayfileToken,
} from '../../packages/core/src/relayfile/client.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function relayPaToken(scopes: string[], ttlSeconds = 120): string {
  const now = 1_800_000_000;
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    scopes,
    iat: now,
    exp: now + ttlSeconds,
  })).toString('base64url');
  return `relay_pa_${header}.${payload}.sig`;
}

function relayPaTokenPair(accessToken: string): Record<string, string> {
  return {
    accessToken,
    accessTokenExpiresAt: '2027-01-15T08:00:00.000Z',
    refreshToken: 'relay_pa_refresh.token.value',
    refreshTokenExpiresAt: '2027-01-16T08:00:00.000Z',
    tokenType: 'Bearer',
  };
}

function relayPaScopes(token: string): string[] {
  const payloadPart = token.slice('relay_pa_'.length).split('.')[1];
  assert.ok(payloadPart);
  const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as {
    scopes?: unknown;
  };
  assert.ok(Array.isArray(payload.scopes));
  return payload.scopes.filter((scope): scope is string => typeof scope === 'string');
}

describe('mintScopedRelayfileToken', () => {
  it('requires workspaceId, relayAuthUrl, and relayAuthApiKey', async () => {
    await assert.rejects(
      mintRelayfileToken({
        workspaceId: '',
        relayAuthUrl: 'https://relayauth.test',
        relayAuthApiKey: 'key',
      }),
      /workspaceId is required/,
    );
    await assert.rejects(
      mintRelayfileToken({
        workspaceId: 'ws_scoped',
        relayAuthUrl: '',
        relayAuthApiKey: 'key',
      }),
      /relayAuthUrl is required/,
    );
    await assert.rejects(
      mintRelayfileToken({
        workspaceId: 'ws_scoped',
        relayAuthUrl: 'https://relayauth.test',
        relayAuthApiKey: '',
      }),
      /relayAuthApiKey is required/,
    );
  });

  it('creates an identity and token with expected RelayAuth POST bodies', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/v1/identities')) {
        return new Response(JSON.stringify({ id: 'id_worker' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ accessToken: 'rs256-access-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const token = await mintScopedRelayfileToken({
      workspaceId: 'ws_scoped',
      agentName: 'worker-agent',
      scopes: ['fs:read', 'relayfile:fs:read:/docs/*', 'fs:read'],
      relayAuthUrl: 'https://relayauth.test',
      relayAuthApiKey: 'api-key',
      ttlSeconds: 90,
    });

    assert.equal(token, 'rs256-access-token');
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.url, 'https://relayauth.test/v1/identities');
    assert.equal(new Headers(calls[0]?.init?.headers).get('x-api-key'), 'api-key');
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
      name: JSON.parse(String(calls[0]?.init?.body)).name,
      type: 'agent',
      sponsorId: 'worker-agent',
      scopes: ['fs:read', 'relayfile:fs:read:/docs/*'],
      metadata: {
        agentName: 'worker-agent',
        productId: 'cloud',
        relayfileWorkspaceId: 'ws_scoped',
      },
      workspaceId: 'ws_scoped',
    });
    assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
      identityId: 'id_worker',
      scopes: ['fs:read', 'relayfile:fs:read:/docs/*'],
      audience: ['relayfile'],
      expiresIn: 90,
    });
  });

  it('keeps legacy mintRelayfileToken callers on the two-step RelayAuth flow', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/v1/identities')) {
        return new Response(JSON.stringify({ id: 'id_legacy' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ accessToken: 'legacy-access-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const token = await mintRelayfileToken({
      workspaceId: 'ws_legacy',
      relayAuthUrl: 'https://relayauth.test',
      relayAuthApiKey: 'api-key',
    });

    assert.equal(token, 'legacy-access-token');
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.url, 'https://relayauth.test/v1/identities');
    assert.equal(calls[1]?.url, 'https://relayauth.test/v1/tokens');
    assert.equal(new Headers(calls[0]?.init?.headers).get('x-api-key'), 'api-key');
    assert.equal(new Headers(calls[1]?.init?.headers).get('x-api-key'), 'api-key');
  });

  it('propagates RelayAuth error responses', async () => {
    globalThis.fetch = async () => new Response('forbidden', { status: 403 });
    await assert.rejects(
      mintRelayfileToken({
        workspaceId: 'ws_scoped',
        relayAuthUrl: 'https://relayauth.test',
        relayAuthApiKey: 'api-key',
      }),
      /RelayAuth request failed \(403\) \/v1\/identities: forbidden/,
    );
  });
});

describe('mintWorkspaceApiKey', () => {
  it('mints a workspace API key with the org RelayAuth API key', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      return new Response(JSON.stringify({
        workspaceToken: { id: 'api_key_row' },
        key: 'relay_ws_workspace-key',
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const key = await mintWorkspaceApiKey({
      workspaceId: 'ws_scoped',
      relayAuthUrl: 'https://relayauth.test',
      relayAuthApiKey: 'org-api-key',
      scopes: [
        'relayauth:token:create:*',
        'relayfile:fs:read:*',
        'relayfile:fs:write:*',
        'relayfile:fs:read:*',
      ],
      name: 'cloud-agent-box:ws_scoped',
    });

    assert.equal(key, 'relay_ws_workspace-key');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'https://relayauth.test/v1/tokens/workspace');
    assert.equal(new Headers(calls[0]?.init?.headers).get('x-api-key'), 'org-api-key');
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
      workspaceId: 'ws_scoped',
      scopes: [
        'relayauth:token:create:*',
        'relayfile:fs:read:*',
        'relayfile:fs:write:*',
      ],
      name: 'cloud-agent-box:ws_scoped',
    });
  });

  it('rejects malformed workspace API key responses', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ key: 'relay_ag_wrong' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });

    await assert.rejects(
      mintWorkspaceApiKey({
        workspaceId: 'ws_scoped',
        relayAuthUrl: 'https://relayauth.test',
        relayAuthApiKey: 'org-api-key',
      }),
      /relay_ws_ key/,
    );
  });
});

describe('mintPathScopedRelayfileToken', () => {
  it('mints a path-scoped relayfile token with the documented relayauth request shape', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const expectedScopes = ['relayfile:fs:read:/github/pull_requests/*'];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      return new Response(JSON.stringify(relayPaTokenPair(relayPaToken(expectedScopes))), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const token = await mintPathScopedRelayfileToken({
      workspaceId: 'ws_scoped',
      relayAuthUrl: 'https://relayauth.test',
      workspaceToken: 'relay_ws_workspace',
      agentName: 'worker-agent',
      paths: ['/github/pull_requests/**'],
      scopes: expectedScopes,
      ttlSeconds: 120,
    });

    assert.deepEqual(relayPaScopes(token), expectedScopes);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'https://relayauth.test/v1/tokens/path');
    assert.equal(
      new Headers(calls[0]?.init?.headers).get('authorization'),
      'Bearer relay_ws_workspace',
    );
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
      workspaceId: 'ws_scoped',
      paths: ['/github/pull_requests/**'],
      ttlSeconds: 120,
      agentName: 'worker-agent',
    });
  });

  it('uses the RelayAuth API key for path-token minting when provided', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify(relayPaTokenPair('relay_pa_access.token.value')), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const token = await mintPathScopedRelayfileToken({
      workspaceId: 'ws_scoped',
      relayAuthUrl: 'https://relayauth.test',
      relayAuthApiKey: 'api-key',
      workspaceToken: 'relay_ws_workspace',
      agentName: 'worker-agent',
      paths: ['/github/pull_requests/**'],
    });

    assert.equal(token, 'relay_pa_access.token.value');
    const headers = new Headers(calls[0]?.init?.headers);
    assert.equal(headers.get('x-api-key'), 'api-key');
    assert.equal(headers.get('authorization'), null);
  });

  it('preserves existing path-token decoded scopes under unchanged 0.2.10 default minting', async () => {
    const expectedScopes = [
      'relayfile:fs:read:/integrations/slack/*',
      'relayfile:fs:write:/integrations/slack/*',
    ];
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { paths?: string[]; scopes?: string[] };
      assert.deepEqual(body, {
        workspaceId: 'ws_scoped',
        paths: ['/integrations/slack/*'],
        ttlSeconds: 300,
        agentName: 'existing-runtime-agent',
      });
      return new Response(JSON.stringify(relayPaTokenPair(relayPaToken(expectedScopes))), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const token = await mintPathScopedRelayfileToken({
      workspaceId: 'ws_scoped',
      relayAuthUrl: 'https://relayauth.test',
      workspaceToken: 'relay_ws_workspace',
      agentName: 'existing-runtime-agent',
      paths: ['/integrations/slack/*'],
      ttlSeconds: 300,
    });

    assert.deepEqual(relayPaScopes(token), expectedScopes);
  });

  it('mints direct workspace-path relay_pa with explicit scopes and no relay_ws material', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const expectedScopes = ['relayfile:fs:write:/github/repos/acme/api/issues/123/*'];
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({
        ...relayPaTokenPair(relayPaToken(expectedScopes)),
        tokenClass: 'relay_pa',
        workspaceId: 'ws_scoped',
        agentId: 'agent-1',
        agentName: 'member-a',
        paths: ['/github/repos/acme/api/issues/123/*'],
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const token = await mintWorkspacePathScopedRelayfileToken({
      workspaceId: 'ws_scoped',
      relayAuthUrl: 'https://relayauth.test',
      relayAuthApiKey: 'org-api-key',
      agentName: 'member-a',
      agentId: 'agent-1',
      paths: ['/github/repos/acme/api/issues/123/*'],
      scopes: expectedScopes,
      ttlSeconds: 120,
    });

    assert.deepEqual(relayPaScopes(token), expectedScopes);
    assert.equal(calls[0]?.url, 'https://relayauth.test/v1/tokens/workspace-path');
    const headers = new Headers(calls[0]?.init?.headers);
    assert.equal(headers.get('x-api-key'), 'org-api-key');
    assert.equal(headers.get('authorization'), null);
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
      workspaceId: 'ws_scoped',
      paths: ['/github/repos/acme/api/issues/123/*'],
      scopes: expectedScopes,
      audience: ['relayfile'],
      ttlSeconds: 120,
      agentName: 'member-a',
      agentId: 'agent-1',
    });
  });

  it('requires either a workspace token or RelayAuth API key for path-token minting', async () => {
    await assert.rejects(
      mintPathScopedRelayfileToken({
        workspaceId: 'ws_scoped',
        relayAuthUrl: 'https://relayauth.test',
        paths: ['/linear/issues/*'],
      }),
      /workspaceToken or relayAuthApiKey is required/,
    );
  });

  it('wraps relayauth path-token errors', async () => {
    globalThis.fetch = async () => new Response('forbidden', { status: 403 });

    await assert.rejects(
      mintPathScopedRelayfileToken({
        workspaceId: 'ws_scoped',
        relayAuthUrl: 'https://relayauth.test',
        workspaceToken: 'relay_ws_workspace',
        paths: ['/linear/issues/*'],
      }),
      /relayauth path-token mint failed: 403 forbidden/,
    );
  });

  it('rejects malformed path-token responses', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ accessToken: 'relay_ag_wrong' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });

    await assert.rejects(
      mintPathScopedRelayfileToken({
        workspaceId: 'ws_scoped',
        relayAuthUrl: 'https://relayauth.test',
        workspaceToken: 'relay_ws_workspace',
        paths: ['/linear/issues/*'],
      }),
      /expected relay_pa_ prefix/,
    );
  });
});

describe('compilePermissionsToScopes', () => {
  it('keeps wildcard relayfile scopes and emits deny scopes when no file list is provided', () => {
    const scopes = compilePermissionsToScopes({
      ignored: ['private/*'],
      readonly: ['docs/*'],
    });

    assert.equal(scopes.includes('fs:read'), true);
    assert.equal(scopes.includes('fs:write'), true);
    assert.equal(scopes.includes('sync:read'), true);
    assert.equal(scopes.includes('relayfile:fs:read:*'), true);
    assert.equal(scopes.includes('relayfile:fs:write:*'), true);
    assert.equal(
      scopes.includes('deny:scope:relayfile:fs:read:/private/*'),
      true,
    );
    assert.equal(
      scopes.includes('deny:scope:relayfile:fs:write:/private/*'),
      true,
    );
    assert.equal(
      scopes.includes('deny:scope:relayfile:fs:write:/docs/*'),
      true,
    );
  });

  it('generates per-file relayfile scopes while retaining required route scopes', () => {
    const scopes = compilePermissionsToScopes(
      {
        ignored: ['private.txt'],
        readonly: ['docs/guide.md'],
      },
      ['docs/readme.md', 'docs/guide.md', 'private.txt'],
    );

    assert.equal(scopes.includes('fs:read'), true);
    assert.equal(scopes.includes('fs:write'), true);
    assert.equal(scopes.includes('sync:read'), true);
    assert.equal(
      scopes.includes('relayfile:fs:read:/docs/readme.md'),
      true,
    );
    assert.equal(
      scopes.includes('relayfile:fs:write:/docs/readme.md'),
      true,
    );
    assert.equal(
      scopes.includes('relayfile:fs:read:/docs/guide.md'),
      true,
    );
    assert.equal(
      scopes.includes('relayfile:fs:write:/docs/guide.md'),
      false,
    );
    assert.equal(
      scopes.includes('relayfile:fs:read:/private.txt'),
      false,
    );
  });

  it('does not emit sync or fs route scopes when no files are granted', () => {
    const scopes = compilePermissionsToScopes(
      { ignored: ['*'] },
      ['docs/readme.md'],
    );

    assert.deepEqual(scopes, []);
  });
});
