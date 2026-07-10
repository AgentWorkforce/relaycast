import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  JsonRpcRequestSchema,
  JsonRpcResponseSchema,
} from '@relaycast/a2a';
import {
  type A2aTaskStore,
  createInMemoryTaskStore,
  handleA2aRpc,
  resetRelayFileIdentityCacheForTests,
} from '../src/routes/a2a-rpc.js';

const mocks = vi.hoisted(() => {
  const verifyMock = vi.fn();
  const githubDelegateMock = vi.fn();
  const linearDelegateMock = vi.fn();
  const createGitHubAgenticSpecialistMock = vi.fn(() => ({
    transport: { delegate: githubDelegateMock },
  }));
  const createLinearAgenticSpecialistMock = vi.fn(() => ({
    transport: { delegate: linearDelegateMock },
  }));

  return {
    verifyMock,
    githubDelegateMock,
    linearDelegateMock,
    createGitHubAgenticSpecialistMock,
    createLinearAgenticSpecialistMock,
  };
});

vi.mock('@relayauth/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@relayauth/sdk')>();

  class MockTokenVerifier {
    async verify(token: string) {
      return mocks.verifyMock(token);
    }
  }

  return {
    ...actual,
    TokenVerifier: MockTokenVerifier,
  };
});

vi.mock('@relayfile/sdk', () => ({
  RelayFileClient: class MockRelayFileClient {
    constructor(readonly options: unknown) {}
  },
}));

vi.mock('../src/specialist/github-specialist-agentic.js', () => ({
  createGitHubAgenticSpecialist: mocks.createGitHubAgenticSpecialistMock,
}));

vi.mock('../src/specialist/linear-specialist-agentic.js', () => ({
  createLinearAgenticSpecialist: mocks.createLinearAgenticSpecialistMock,
}));

function createEnv() {
  return {
    OPENROUTER_API_KEY: 'test-openrouter-key',
    RELAYFILE_URL: 'https://relayfile.example.test',
    RELAY_JWT_SECRET: 'test-relay-jwt-secret',
    // Required by createRelayFileClient on the request-handling path; the
    // RelayFile client itself is mocked above, but the route still validates
    // these bindings before reaching the mock.
    SPECIALIST_RELAYAUTH_URL: 'https://api.relayauth.example.test',
    SPECIALIST_RELAYAUTH_API_KEY: 'test-specialist-api-key',
  };
}

function createClaims(workspaceId = 'ws_test_123') {
  return {
    sub: 'specialist-worker',
    org: 'org_test',
    wks: workspaceId,
    workspace_id: workspaceId,
    scopes: ['delegation:write'],
    sponsorId: 'sponsor_test',
    sponsorChain: ['sponsor_test'],
    token_type: 'access' as const,
    iss: 'https://api.relayauth.dev',
    aud: ['specialist-worker'],
    exp: Math.floor(Date.now() / 1000) + 60 * 60,
    iat: Math.floor(Date.now() / 1000),
    jti: 'jwt_test',
  };
}

type TestEnv = {
  Bindings: ReturnType<typeof createEnv>;
  Variables: {
    config?: {
      relayAuthAudience?: string[];
      relayAuthIssuer: string;
      relayAuthJwksUrl: string;
    };
  };
};

function createApp(store: A2aTaskStore = createInMemoryTaskStore()) {
  const app = new Hono<TestEnv>();

  app.post('/a2a/rpc', (c) => handleA2aRpc(c, store));

  return app;
}

function createMessageSendRequest() {
  return JsonRpcRequestSchema.parse({
    jsonrpc: '2.0',
    id: 'rpc-1',
    method: 'message/send',
    params: {
      message: {
        message_id: 'msg-1',
        role: 'user',
        context_id: 'ctx-1',
        parts: [
          {
            kind: 'text',
            text: JSON.stringify({
              requestId: 'task-1',
              capability: 'github.enumerate',
              params: {
                capability: 'github.enumerate',
                query: 'repo:agent-workforce',
              },
            }),
          },
        ],
      },
    },
  });
}

function createLinearMessageSendRequest() {
  return JsonRpcRequestSchema.parse({
    jsonrpc: '2.0',
    id: 'rpc-linear',
    method: 'message/send',
    params: {
      message: {
        message_id: 'msg-linear',
        role: 'user',
        context_id: 'ctx-linear',
        parts: [
          {
            kind: 'text',
            text: JSON.stringify({
              requestId: 'task-linear',
              capability: 'linear.enumerate',
              params: {
                capability: 'linear.enumerate',
                query: 'blocked issues',
              },
            }),
          },
        ],
      },
    },
  });
}

describe('A2A JSON-RPC route', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mocks.verifyMock.mockReset();
    mocks.githubDelegateMock.mockReset();
    mocks.linearDelegateMock.mockReset();
    mocks.createGitHubAgenticSpecialistMock.mockClear();
    mocks.createLinearAgenticSpecialistMock.mockClear();
    resetRelayFileIdentityCacheForTests();

    mocks.verifyMock.mockResolvedValue(createClaims());
    mocks.githubDelegateMock.mockResolvedValue({
      requestId: 'task-1',
      capability: 'github.enumerate',
      status: 'complete',
      summary: 'Enumerated matching GitHub artifacts.',
      findings: [],
      confidence: 0.9,
    });
    mocks.linearDelegateMock.mockResolvedValue({
      requestId: 'task-linear',
      capability: 'linear.enumerate',
      status: 'complete',
      summary: 'Enumerated matching Linear artifacts.',
      findings: [],
      confidence: 0.9,
    });

    // Stub the outbound /v1/identities + /v1/tokens RelayAuth mint calls made
    // by createRelayFileClient so tests stay offline. Any other URL falls
    // through to the real fetch (but nothing else is expected).
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.endsWith('/v1/identities')) {
        return new Response(JSON.stringify({ id: 'identity_test' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/v1/tokens')) {
        return new Response(JSON.stringify({ accessToken: 'relayfile_access_test' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('message/send returns a JSON-RPC success with an agent text message', async () => {
    const app = createApp();

    const response = await app.request(
      'http://localhost/a2a/rpc',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(createMessageSendRequest()),
      },
      createEnv(),
    );

    expect(response.status).toBe(200);

    const body = JsonRpcResponseSchema.parse(await response.json());
    expect(body.error).toBeUndefined();
    expect(body.result?.message?.role).toBe('agent');
    expect(body.result?.message?.parts[0]?.kind).toBe('text');
    expect(body.result?.task?.status.state).toBe('completed');
    expect(mocks.verifyMock).toHaveBeenCalledWith('valid-token');
    expect(mocks.githubDelegateMock).toHaveBeenCalledTimes(1);
  });

  it('reuses the RelayAuth identity while minting fresh RelayFile tokens', async () => {
    const app = createApp();
    const requestInit = {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(createMessageSendRequest()),
    };

    await app.request('http://localhost/a2a/rpc', requestInit, createEnv());
    await app.request('http://localhost/a2a/rpc', requestInit, createEnv());

    const urls = fetchSpy.mock.calls.map((call) => {
      const input = call[0];
      return typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    });
    expect(urls.filter((url) => url.endsWith('/v1/identities'))).toHaveLength(1);
    expect(urls.filter((url) => url.endsWith('/v1/tokens'))).toHaveLength(2);
  });

  it('refreshes the cached RelayAuth identity when token minting reports it stale', async () => {
    let identityCalls = 0;
    let tokenCalls = 0;
    fetchSpy.mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.endsWith('/v1/identities')) {
        identityCalls += 1;
        return new Response(JSON.stringify({ id: `identity_${identityCalls}` }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/v1/tokens')) {
        tokenCalls += 1;
        const body = JSON.parse((init?.body as string | undefined) ?? '{}') as { identityId?: string };
        if (tokenCalls === 2 && body.identityId === 'identity_1') {
          return new Response('identity not found', { status: 404 });
        }
        return new Response(JSON.stringify({ accessToken: `relayfile_access_${tokenCalls}` }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });

    const app = createApp();
    const requestInit = {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(createMessageSendRequest()),
    };

    await app.request('http://localhost/a2a/rpc', requestInit, createEnv());
    await app.request('http://localhost/a2a/rpc', requestInit, createEnv());

    expect(identityCalls).toBe(2);
    expect(tokenCalls).toBe(3);
  });

  it('dedupes concurrent cached-identity refreshes after stale token failures', async () => {
    let identityCalls = 0;
    let tokenCalls = 0;
    fetchSpy.mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.endsWith('/v1/identities')) {
        identityCalls += 1;
        if (identityCalls > 1) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return new Response(JSON.stringify({ id: `identity_${identityCalls}` }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/v1/tokens')) {
        tokenCalls += 1;
        const body = JSON.parse((init?.body as string | undefined) ?? '{}') as { identityId?: string };
        if (body.identityId === 'identity_1' && tokenCalls > 1) {
          return new Response('identity not found', { status: 404 });
        }
        return new Response(JSON.stringify({ accessToken: `relayfile_access_${tokenCalls}` }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });

    const app = createApp();
    const requestInit = {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(createMessageSendRequest()),
    };

    await app.request('http://localhost/a2a/rpc', requestInit, createEnv());
    await Promise.all([
      app.request('http://localhost/a2a/rpc', requestInit, createEnv()),
      app.request('http://localhost/a2a/rpc', requestInit, createEnv()),
    ]);

    expect(identityCalls).toBe(2);
    expect(tokenCalls).toBe(5);
  });

  it('malformed body returns JSON-RPC invalid request error', async () => {
    const app = createApp();

    const response = await app.request(
      'http://localhost/a2a/rpc',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: '{',
      },
      createEnv(),
    );

    expect(response.status).toBe(200);

    const body = JsonRpcResponseSchema.parse(await response.json());
    expect(body.error?.code).toBe(-32600);
    expect(body.result).toBeUndefined();
  });

  it('unknown method returns JSON-RPC method not found error', async () => {
    const app = createApp();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const response = await app.request(
      'http://localhost/a2a/rpc',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'rpc-unknown-method',
          method: 'unknown/method',
        }),
      },
      createEnv(),
    );

    expect(response.status).toBe(200);

    const body = JsonRpcResponseSchema.parse(await response.json());
    expect(body.error?.code).toBe(-32601);
    expect(body.result).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith('[specialist/a2a-rpc] request:', {
      method: 'unknown/method',
      hasAuthHeader: false,
      bodyKeys: [],
    });
  });

  it('tasks/get for an unknown id returns not_found status', async () => {
    const app = createApp();

    const response = await app.request(
      'http://localhost/a2a/rpc',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'rpc-get',
          method: 'tasks/get',
          params: { id: 'missing-task' },
        }),
      },
      createEnv(),
    );

    expect(response.status).toBe(200);

    const body = JsonRpcResponseSchema.parse(await response.json());
    expect(body.error).toBeUndefined();
    expect((body.result as { status?: string } | undefined)?.status).toBe('not_found');
  });

  it('logs a bounded summary when request dispatch fails', async () => {
    const app = createApp();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const response = await app.request(
      'http://localhost/a2a/rpc',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'rpc-get-invalid',
          method: 'tasks/get',
          params: {},
        }),
      },
      createEnv(),
    );

    expect(response.status).toBe(200);

    const body = JsonRpcResponseSchema.parse(await response.json());
    expect(body.error?.code).toBe(-32602);
    expect(logSpy).toHaveBeenCalledWith('[specialist/a2a-rpc] request failed:', {
      rpcCode: -32602,
      code: 'invalid_task_id',
      status: 400,
      errorMessage: 'tasks/get and tasks/cancel require params.id',
    });
  });

  it('wires githubApiFallback + githubLibrarianApiFallback when cloud web GitHub proxy creds are set', async () => {
    const app = createApp();
    const envWithToken = {
      ...createEnv(),
      CLOUD_API_URL: 'https://cloud.example',
      SPECIALIST_CLOUD_API_TOKEN: 'cloud-token',
    };

    await app.request(
      'http://localhost/a2a/rpc',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(createMessageSendRequest()),
      },
      envWithToken,
    );

    expect(mocks.createGitHubAgenticSpecialistMock).toHaveBeenCalledTimes(1);
    const opts = mocks.createGitHubAgenticSpecialistMock.mock.calls[0]![0] as {
      githubApiFallback?: unknown;
      githubLibrarianApiFallback?: unknown;
    };
    expect(opts.githubApiFallback).toBeTruthy();
    expect(opts.githubLibrarianApiFallback).toBeTruthy();
  });

  it('omits fallbacks when cloud web GitHub proxy creds are absent (VFS-only fallback)', async () => {
    const app = createApp();
    await app.request(
      'http://localhost/a2a/rpc',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(createMessageSendRequest()),
      },
      createEnv(),
    );

    expect(mocks.createGitHubAgenticSpecialistMock).toHaveBeenCalledTimes(1);
    const opts = mocks.createGitHubAgenticSpecialistMock.mock.calls[0]![0] as {
      githubApiFallback?: unknown;
      githubLibrarianApiFallback?: unknown;
    };
    expect(opts.githubApiFallback).toBeUndefined();
    expect(opts.githubLibrarianApiFallback).toBeUndefined();
  });

  it('forwards DEBUG_SPECIALIST into the linear specialist', async () => {
    const app = createApp();
    await app.request(
      'http://localhost/a2a/rpc',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(createLinearMessageSendRequest()),
      },
      {
        ...createEnv(),
        DEBUG_SPECIALIST: 'true',
      },
    );

    expect(mocks.createLinearAgenticSpecialistMock).toHaveBeenCalledTimes(1);
    expect(mocks.createLinearAgenticSpecialistMock.mock.calls[0]![0]).toMatchObject({
      debugSpecialist: 'true',
    });
  });

  it('tasks/cancel for an unknown id returns not_found status without JSON-RPC error', async () => {
    const app = createApp();

    const response = await app.request(
      'http://localhost/a2a/rpc',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'rpc-cancel',
          method: 'tasks/cancel',
          params: { id: 'missing-task' },
        }),
      },
      createEnv(),
    );

    expect(response.status).toBe(200);

    const body = JsonRpcResponseSchema.parse(await response.json());
    expect(body.error).toBeUndefined();
    expect((body.result as { status?: string } | undefined)?.status).toBe('not_found');
  });
});
