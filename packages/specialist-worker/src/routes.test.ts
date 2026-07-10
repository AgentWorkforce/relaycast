import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const verifyMock = vi.fn();
  const nextStepMock = vi.fn();
  const createOpenRouterModelAdapterMock = vi.fn(() => ({
    nextStep: nextStepMock,
  }));
  const issueTokenMock = vi.fn(async () => ({
    accessToken: 'test-relayfile-token',
    refreshToken: 'test-relayfile-refresh',
  }));
  const relayAuthClientMock = vi.fn();

  return {
    verifyMock,
    nextStepMock,
    createOpenRouterModelAdapterMock,
    issueTokenMock,
    relayAuthClientMock,
  };
});

vi.mock('@relayauth/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@relayauth/sdk')>();

  class MockTokenVerifier {
    async verify(token: string) {
      return mocks.verifyMock(token);
    }
  }

  class MockRelayAuthClient {
    options: { baseUrl: string; apiKey?: string; token?: string };

    constructor(options: { baseUrl: string; apiKey?: string; token?: string }) {
      this.options = options;
      mocks.relayAuthClientMock(options);
    }

    issueToken = mocks.issueTokenMock;
  }

  return {
    ...actual,
    TokenVerifier: MockTokenVerifier,
    RelayAuthClient: MockRelayAuthClient,
  };
});

vi.mock('@agent-assistant/harness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-assistant/harness')>();

  return {
    ...actual,
    createOpenRouterModelAdapter: mocks.createOpenRouterModelAdapterMock,
  };
});

import { createApp } from './routes.js';
import { A2aAgentCardSchema } from '@relaycast/a2a';

function createEnv() {
  return {
    OPENROUTER_API_KEY: 'test-openrouter-key',
    RELAYFILE_URL: 'https://relayfile.example.test',
    SPECIALIST_RELAYAUTH_URL: 'https://api.relayauth.test',
    SPECIALIST_RELAYAUTH_API_KEY: 'test-specialist-relayauth-api-key',
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

function createDelegateBody(
  capability: string,
  params: Record<string, unknown> = {},
) {
  return {
    requestId: `req-${capability.replace(/\./g, '-')}`,
    capability,
    params: {
      capability,
      ...params,
    },
  };
}

function createA2aRpcMessageSendBody(
  capability: string,
  params: Record<string, unknown> = {},
) {
  return {
    jsonrpc: '2.0',
    id: `rpc-${capability.replace(/\./g, '-')}`,
    method: 'message/send',
    params: {
      message: {
        message_id: `msg-${capability.replace(/\./g, '-')}`,
        role: 'user',
        parts: [
          {
            kind: 'text',
            text: JSON.stringify(createDelegateBody(capability, params)),
          },
        ],
      },
    },
  };
}

function createFindingsAnswer(summary = 'GitHub findings ready') {
  return {
    type: 'final_answer' as const,
    text: `\`\`\`json
${JSON.stringify(
  {
    status: 'complete',
    summary,
    findings: [
      {
        title: 'Finding 1',
        body: 'Structured finding emitted by the mock model.',
      },
    ],
    confidence: 0.92,
  },
  null,
  2,
)}
\`\`\``,
  };
}

function extractDelegationRequestFromModelInput() {
  const firstCall = mocks.nextStepMock.mock.calls[0]?.[0];
  const developerPrompt = firstCall?.instructions?.developerPrompt;

  expect(typeof developerPrompt).toBe('string');

  const match = /```json\s*([\s\S]*?)\s*```/u.exec(developerPrompt as string);
  expect(match?.[1]).toBeTruthy();

  return JSON.parse(match![1]) as {
    requestId: string;
    capability: string;
    params: Record<string, unknown>;
    timeoutMs?: number;
    metadata?: Record<string, unknown>;
    workspaceId?: string;
  };
}

describe('specialist worker routes', () => {
  beforeEach(() => {
    mocks.verifyMock.mockReset();
    mocks.nextStepMock.mockReset();
    mocks.createOpenRouterModelAdapterMock.mockClear();
    mocks.issueTokenMock.mockClear();
    mocks.relayAuthClientMock.mockClear();
    // Stub fetch for the RelayAuth identity-create call that
    // createRelayFileClient makes before issueToken.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ id: 'identity-test' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GET /.well-known/agent-card.json returns a valid agent card with github and linear capabilities', async () => {
    const app = createApp();

    const response = await app.request(
      'http://localhost/.well-known/agent-card.json',
      undefined,
      createEnv(),
    );

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(() => A2aAgentCardSchema.parse(body)).not.toThrow();
    expect(body).toEqual(
      expect.objectContaining({
        skills: expect.arrayContaining([
          expect.objectContaining({ id: 'github.enumerate' }),
          expect.objectContaining({ id: 'pr_investigation' }),
          expect.objectContaining({ id: 'linear.enumerate' }),
        ]),
      }),
    );
    // Sage's agent-card parser (src/swarm/specialist/agent-card.ts:110)
    // throws "Agent card capabilities are required" when the top-level
    // capabilities field is missing. Regression guard.
    expect(body).toHaveProperty('capabilities');
    expect((body as { capabilities: unknown }).capabilities).toEqual(
      expect.objectContaining({ streaming: expect.any(Boolean) }),
    );
  });

  it('GET /.well-known/agent.json redirects to the A2A agent card with deprecation headers', async () => {
    const app = createApp();

    const response = await app.request(
      'http://localhost/.well-known/agent.json',
      undefined,
      createEnv(),
    );

    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toEqual(
      expect.stringMatching(/\/\.well-known\/agent-card\.json$/u),
    );
    expect(response.headers.get('deprecation')).toBe('true');
  });

  it('POST /delegate returns deprecated endpoint response', async () => {
    const app = createApp();

    const response = await app.request(
      'http://localhost/delegate',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(
          createDelegateBody('github.enumerate', { query: 'repo:agent-workforce' }),
        ),
      },
      createEnv(),
    );

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ code: 'deprecated_endpoint' });
  });

  it('POST /a2a/rpc without bearer returns 401', async () => {
    const app = createApp();

    const response = await app.request(
      'http://localhost/a2a/rpc',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(createA2aRpcMessageSendBody('github.enumerate', {
          query: 'repo:agent-workforce',
        })),
      },
      createEnv(),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'Missing Authorization header',
      code: 'missing_authorization',
    });
    expect(mocks.verifyMock).not.toHaveBeenCalled();
  });

  it('POST /a2a/rpc with valid token but unknown capability returns JSON-RPC invalid params', async () => {
    mocks.verifyMock.mockResolvedValue(createClaims());
    const app = createApp();

    const response = await app.request(
      'http://localhost/a2a/rpc',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(createA2aRpcMessageSendBody('unknown.capability', {
          query: 'ignored',
        })),
      },
      createEnv(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          code: -32602,
          data: expect.objectContaining({ code: 'unknown_capability' }),
        }),
      }),
    );
    expect(mocks.verifyMock).toHaveBeenCalledWith('valid-token');
    expect(mocks.nextStepMock).not.toHaveBeenCalled();
  });

  it('POST /a2a/rpc with github.enumerate returns SpecialistFindings from the mocked OpenRouter model', async () => {
    mocks.verifyMock.mockResolvedValue(createClaims());
    mocks.nextStepMock.mockResolvedValue(
      createFindingsAnswer('Enumerated matching GitHub artifacts.'),
    );

    const app = createApp();

    const response = await app.request(
      'http://localhost/a2a/rpc',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(createA2aRpcMessageSendBody('github.enumerate', {
          query: 'repo:agent-workforce is:pr',
        })),
      },
      createEnv(),
    );

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          message: expect.objectContaining({
            role: 'agent',
            parts: expect.arrayContaining([
              expect.objectContaining({ kind: 'text' }),
            ]),
          }),
          task: expect.objectContaining({
            id: 'req-github-enumerate',
            metadata: expect.objectContaining({
              capability: 'github.enumerate',
            }),
          }),
        }),
      }),
    );

    const findings = JSON.parse(body.result.message.parts[0].text);
    expect(findings.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Finding 1',
        }),
      ]),
    );
    expect(mocks.createOpenRouterModelAdapterMock).toHaveBeenCalled();
    expect(mocks.nextStepMock).toHaveBeenCalledTimes(1);
  });

  it('POST /a2a/rpc propagates the verified token workspaceId into the specialist DelegationRequest', async () => {
    const workspaceId = 'ws_from_verified_token';

    mocks.verifyMock.mockResolvedValue(createClaims(workspaceId));
    mocks.nextStepMock.mockResolvedValue(
      createFindingsAnswer('Workspace-scoped enumeration completed.'),
    );

    const app = createApp();

    const response = await app.request(
      'http://localhost/a2a/rpc',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(createA2aRpcMessageSendBody('github.enumerate', {
          query: 'repo:agent-workforce label:bug',
        })),
      },
      createEnv(),
    );

    expect(response.status).toBe(200);
    expect(mocks.nextStepMock).toHaveBeenCalledTimes(1);

    const delegationRequest = extractDelegationRequestFromModelInput();

    expect(delegationRequest).toEqual(
      expect.objectContaining({
        requestId: 'req-github-enumerate',
        capability: 'github.enumerate',
      }),
    );

    expect(delegationRequest.metadata).toEqual(
      expect.objectContaining({
        workspaceId,
      }),
    );
  });

  it('fails fast with HTTP 500 when SPECIALIST_RELAYAUTH_API_KEY is missing on the binding', async () => {
    // With the boot-time binding validator (src/config/require-bindings.ts)
    // a missing required binding is caught by the `*` middleware BEFORE
    // the request reaches handleA2aRpc. The response is an HTTP 500 with
    // a JSON body carrying `specialist_configuration_error` and the list
    // of missing names, so a post-deploy smoke probe surfaces the
    // misconfiguration immediately instead of tunnelling through to a
    // generic downstream failure.
    mocks.verifyMock.mockResolvedValue(createClaims());

    const app = createApp();
    const { SPECIALIST_RELAYAUTH_API_KEY: _omit, ...envWithoutSecret } = createEnv();

    const response = await app.request(
      'http://localhost/a2a/rpc',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(createA2aRpcMessageSendBody('github.enumerate', {
          query: 'repo:x',
        })),
      },
      envWithoutSecret,
    );

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual(
      expect.objectContaining({
        code: 'specialist_configuration_error',
        missing: expect.arrayContaining(['SPECIALIST_RELAYAUTH_API_KEY']),
      }),
    );
    expect(mocks.nextStepMock).not.toHaveBeenCalled();
  });
});
