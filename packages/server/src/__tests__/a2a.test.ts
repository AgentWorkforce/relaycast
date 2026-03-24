import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/index.js', () => ({
  getDb: vi.fn(),
}));

vi.mock('../engine/agent.js', () => ({
  touchLastSeen: vi.fn().mockResolvedValue(undefined),
  registerAgent: vi.fn(),
}));

import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { hashToken } from '../middleware/auth.js';
import { dbMiddleware } from '../middleware/db.js';
import { a2aRoutes } from '../routes/a2a.js';
import { getDb } from '../db/index.js';
import { registerAgent } from '../engine/agent.js';
import * as a2aEngine from '../engine/a2a.js';
import * as dmEngine from '../engine/dm.js';
import { runA2aHealthChecks } from '../engine/a2a-health.js';
import {
  FAKE_WORKSPACE,
  TEST_AGENT_TOKEN,
  createMockBindings,
  mockDbForWorkspaceAuth,
  wsAuthHeaders,
} from './test-helpers.js';

const bindings = createMockBindings();

const app = new Hono<AppEnv>();
app.use('*', dbMiddleware);
app.route('/', a2aRoutes);

app.onError((err, c) => {
  const error = err as Error & { code?: string; status?: number };
  return c.json(
    { ok: false, error: { code: error.code || 'internal_error', message: error.message } },
    (error.status || 500) as 500,
  );
});

const INLINE_CARD = {
  name: 'Weather Agent',
  description: 'Weather forecasts and alerts',
  url: 'https://weather.example.com/rpc',
  version: '1.0.0',
  skills: [{ id: 'forecast', name: 'forecast', description: 'Get forecasts' }],
};
const TEST_AGENT_TOKEN_HASH = hashToken(TEST_AGENT_TOKEN);

function createQueuedSelectDb(results: unknown[][]) {
  const queue = [...results];
  const next = () => Promise.resolve((queue.shift() ?? []) as never);

  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => next()),
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => next()),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn().mockResolvedValue([]),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([]),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn().mockResolvedValue([]),
    })),
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  } as any;
}

function createRegistrationDb() {
  const inserted: unknown[] = [];

  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([]),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((value: unknown) => {
        inserted.push(value);
        return Promise.resolve([]);
      }),
    })),
  } as any;

  return { db, inserted };
}

function createHealthDb(rows: Array<{
  id: string;
  workspace_id: string;
  relay_agent_id: string;
  external_url: string;
  health_failures: number;
}>) {
  const updates: Array<[string, number, string]> = [];

  const db = {
    $client: {
      prepare: vi.fn((sql: string) => {
        if (sql.includes('SELECT id, workspace_id, relay_agent_id, external_url, health_failures')) {
          return {
            all: vi.fn().mockResolvedValue({ results: rows }),
          };
        }

        if (sql.includes('UPDATE a2a_agents')) {
          return {
            bind: vi.fn((status: string, healthFailures: number, agentId: string) => {
              updates.push([status, healthFailures, agentId]);
              return {
                run: vi.fn().mockResolvedValue({ success: true }),
              };
            }),
          };
        }

        throw new Error(`Unexpected SQL in test: ${sql}`);
      }),
    },
  };

  return { db, updates };
}

describe('A2A registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('registers with an agent card URL and returns the relay webhook URL', async () => {
    vi.spyOn(a2aEngine, 'registerA2aAgent').mockResolvedValue({
      relayName: 'ext-weather-12345678',
      relayToken: 'at_live_proxy_token',
      webhookUrl: '/a2a/webhook/ext-weather-12345678',
      certification: 'level_1',
    });

    const res = await app.request('/v1/a2a/register', {
      method: 'POST',
      headers: wsAuthHeaders(),
      body: JSON.stringify({ agent_card_url: 'https://weather.example.com/.well-known/agent-card.json' }),
    }, bindings);

    expect(res.status).toBe(201);
    expect(vi.mocked(a2aEngine.registerA2aAgent)).toHaveBeenCalledWith(
      expect.anything(),
      FAKE_WORKSPACE.id,
      expect.objectContaining({
        agentCardUrl: 'https://weather.example.com/.well-known/agent-card.json',
      }),
    );

    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data.relay_name).toBe('ext-weather-12345678');
    expect(body.data.webhook_url).toBe('http://localhost/a2a/webhook/ext-weather-12345678');
  });

  it('registers with an inline agent card', async () => {
    vi.spyOn(a2aEngine, 'registerA2aAgent').mockResolvedValue({
      relayName: 'ext-weather-12345678',
      relayToken: 'at_live_proxy_token',
      webhookUrl: '/a2a/webhook/ext-weather-12345678',
      certification: 'level_1',
    });

    const res = await app.request('/v1/a2a/register', {
      method: 'POST',
      headers: wsAuthHeaders(),
      body: JSON.stringify({ agent_card: INLINE_CARD }),
    }, bindings);

    expect(res.status).toBe(201);
    expect(vi.mocked(a2aEngine.registerA2aAgent)).toHaveBeenCalledWith(
      expect.anything(),
      FAKE_WORKSPACE.id,
      expect.objectContaining({
        agentCard: INLINE_CARD,
      }),
    );
  });

  it('creates the relay agent record when registering with an inline agent card', async () => {
    const { db, inserted } = createRegistrationDb();

    vi.mocked(registerAgent).mockResolvedValue({
      id: 'agent_ext_1',
      token: 'at_live_proxy_token',
    } as any);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));

    const result = await a2aEngine.registerA2aAgent(db, FAKE_WORKSPACE.id, {
      agentCard: INLINE_CARD,
      authScheme: 'bearer',
      authCredential: 'secret',
    });

    expect(registerAgent).toHaveBeenCalledWith(
      db,
      FAKE_WORKSPACE.id,
      expect.objectContaining({
        name: result.relayName,
        type: 'external',
        metadata: expect.objectContaining({
          a2a: true,
          a2a_external_url: 'https://weather.example.com/rpc',
        }),
      }),
    );
    expect(inserted).toHaveLength(2);
    expect(inserted[0]).toEqual(expect.objectContaining({
      workspaceId: FAKE_WORKSPACE.id,
      relayAgentId: 'agent_ext_1',
      externalUrl: 'https://weather.example.com/rpc',
      authScheme: 'bearer',
      authCredential: 'secret',
      status: 'active',
    }));
    expect(inserted[1]).toEqual(expect.objectContaining({
      workspaceId: FAKE_WORKSPACE.id,
      agentUrl: 'https://weather.example.com/rpc',
      level: 1,
      source: 'registration',
      status: 'pending',
    }));
    expect(result.webhookUrl).toBe(`/a2a/webhook/${result.relayName}`);
  });

  it('fetches the remote agent card URL before provisioning the relay agent', async () => {
    const { db } = createRegistrationDb();

    vi.mocked(registerAgent).mockResolvedValue({
      id: 'agent_ext_2',
      token: 'at_live_proxy_token',
    } as any);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(INLINE_CARD), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 })));

    const result = await a2aEngine.registerA2aAgent(db, FAKE_WORKSPACE.id, {
      agentCardUrl: 'https://weather.example.com/.well-known/agent-card.json',
    });

    expect(fetch).toHaveBeenNthCalledWith(1, 'https://weather.example.com/.well-known/agent-card.json', {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    expect(result.relayName).toMatch(/^ext-weather-agent-/);
  });
});

describe('A2A message translation', () => {
  it('translates a Relay DM into an A2A SendMessage request and preserves thread_id as context_id', () => {
    const payload = a2aEngine.translateRelayToA2a({
      id: 'msg_123',
      agent_id: 'agent_lead',
      agent_name: 'LeadAgent',
      text: 'Status update?',
      thread_id: 'conv_123',
      attachments: [],
    });

    expect(payload).toEqual(expect.objectContaining({
      jsonrpc: '2.0',
      id: 'msg_123',
      method: 'message/send',
      params: expect.objectContaining({
        message: expect.objectContaining({
          message_id: 'msg_123',
          context_id: 'conv_123',
          parts: [{ kind: 'text', text: 'Status update?' }],
        }),
      }),
    }));
  });

  it('translates an A2A JSON-RPC response back into a Relay DM and preserves contextId as thread_id', () => {
    const relayMessage = a2aEngine.translateA2aToRelay({
      jsonrpc: '2.0',
      id: 'msg_123',
      result: {
        message: {
          message_id: 'upstream_1',
          role: 'agent',
          context_id: 'conv_123',
          parts: [{ kind: 'text', text: 'All clear.' }],
        },
      },
    });

    expect(relayMessage).toEqual(expect.objectContaining({
      id: 'msg_123',
      text: 'All clear.',
      thread_id: 'conv_123',
    }));
  });
});

describe('A2A webhook handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes an incoming A2A webhook message to the requested Relay agent and returns a task response', async () => {
    const webhookDb = createQueuedSelectDb([[
      {
        workspaceId: FAKE_WORKSPACE.id,
        relayAgentId: 'agent_proxy',
        relayName: 'ext-weather-12345678',
        tokenHash: TEST_AGENT_TOKEN_HASH,
      },
    ]]);
    vi.mocked(getDb).mockReturnValue(webhookDb);

    vi.spyOn(dmEngine, 'sendDm').mockResolvedValue({
      conversation_id: 'conv_123',
      message: {
        id: 'msg_reply_1',
        text: 'Queued for LeadAgent',
      },
    } as any);
    vi.spyOn(a2aEngine, 'getA2aAgentByRelayName').mockResolvedValue({
      id: 'a2a_1',
    } as any);
    vi.spyOn(a2aEngine, 'incrementA2aMessagesReceived').mockResolvedValue();

    const res = await app.request('/a2a/webhook/ext-weather-12345678', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_AGENT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'rpc_1',
        method: 'message/send',
        params: {
          message: {
            message_id: 'rpc_1',
            role: 'agent',
            context_id: 'conv_123',
            parts: [{ kind: 'text', text: 'Weather alert received' }],
          },
          metadata: {
            target_agent: 'LeadAgent',
          },
        },
      }),
    }, bindings);

    expect(res.status).toBe(200);
    expect(dmEngine.sendDm).toHaveBeenCalledWith(
      expect.anything(),
      FAKE_WORKSPACE.id,
      'agent_proxy',
      expect.objectContaining({
        to: 'LeadAgent',
        text: 'Weather alert received',
        mode: 'wait',
      }),
      { skipA2aIntercept: true },
    );

    const body = await res.json() as any;
    expect(body.result.task.context_id).toBe('conv_123');
    expect(body.result.task.metadata.target_agent).toBe('LeadAgent');
  });

  it('maps a JSON-RPC response back to the original Relay sender using the correlation id', async () => {
    const db = createQueuedSelectDb([
      [{
        workspaceId: FAKE_WORKSPACE.id,
        relayAgentId: 'agent_proxy',
        relayName: 'ext-weather-12345678',
        tokenHash: TEST_AGENT_TOKEN_HASH,
      }],
      [{
        agentName: 'LeadAgent',
      }],
    ]);
    vi.mocked(getDb).mockReturnValue(db);

    vi.spyOn(dmEngine, 'sendDm').mockResolvedValue({
      conversation_id: 'conv_123',
      message: {
        id: 'msg_reply_2',
        text: 'Rain tomorrow',
      },
    } as any);
    vi.spyOn(a2aEngine, 'getA2aAgentByRelayName').mockResolvedValue({
      id: 'a2a_1',
    } as any);
    vi.spyOn(a2aEngine, 'incrementA2aMessagesReceived').mockResolvedValue();

    const res = await app.request('/a2a/webhook/ext-weather-12345678', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_AGENT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'msg_123',
        result: {
          message: {
            message_id: 'upstream_1',
            role: 'agent',
            context_id: 'conv_123',
            parts: [{ kind: 'text', text: 'Rain tomorrow' }],
          },
        },
      }),
    }, bindings);

    expect(res.status).toBe(200);
    expect(dmEngine.sendDm).toHaveBeenCalledWith(
      expect.anything(),
      FAKE_WORKSPACE.id,
      'agent_proxy',
      expect.objectContaining({
        to: 'LeadAgent',
        text: 'Rain tomorrow',
      }),
      { skipA2aIntercept: true },
    );
  });
});

describe('A2A health checking', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps an agent active when the health endpoint returns 200', async () => {
    const { db, updates } = createHealthDb([
      {
        id: 'a2a_healthy',
        workspace_id: 'ws_1',
        relay_agent_id: 'agent_1',
        external_url: 'https://healthy.example.com/rpc',
        health_failures: 2,
      },
    ]);
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }));

    const result = await runA2aHealthChecks(db as never);

    expect(updates).toEqual([['active', 0, 'a2a_healthy']]);
    expect(result).toEqual({
      checked: 1,
      healthy: 1,
      failed: 0,
      suspended: 0,
    });
  });

  it('suspends an agent after the third consecutive failed health check', async () => {
    const { db, updates } = createHealthDb([
      {
        id: 'a2a_suspended',
        workspace_id: 'ws_1',
        relay_agent_id: 'agent_2',
        external_url: 'https://down.example.com/rpc',
        health_failures: 2,
      },
    ]);
    vi.mocked(fetch).mockResolvedValue(new Response('nope', { status: 500 }));

    const result = await runA2aHealthChecks(db as never);

    expect(updates).toEqual([['suspended', 3, 'a2a_suspended']]);
    expect(result).toEqual({
      checked: 1,
      healthy: 0,
      failed: 1,
      suspended: 1,
    });
  });
});

describe('Workspace agent card serving', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(createQueuedSelectDb([
      [FAKE_WORKSPACE],
      [FAKE_WORKSPACE],
    ]));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('serves a valid A2A card from /.well-known/agent-card.json', async () => {
    vi.spyOn(a2aEngine, 'getWorkspaceAgentCard').mockResolvedValue({
      name: FAKE_WORKSPACE.name,
      description: `Relaycast workspace card for ${FAKE_WORKSPACE.name}`,
      url: 'http://localhost/a2a/rpc',
      version: '1.0.0',
      skills: [{ id: 'LeadAgent', name: 'LeadAgent', description: 'Workspace agent', tags: ['relaycast', 'agent'] }],
      provider: { organization: 'Relaycast' },
      capabilities: { methods: ['message/send'] },
      default_input_modes: ['text/plain'],
      default_output_modes: ['text/plain'],
      documentation_url: 'https://github.com/AgentWorkforce/relaycast',
    });

    const res = await app.request('/.well-known/agent-card.json?workspace=test-workspace', {}, bindings);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(() => a2aEngine.A2aAgentCardSchema.parse(body)).not.toThrow();
    expect((body as any).url).toBe('http://localhost/a2a/rpc');
  });
});
