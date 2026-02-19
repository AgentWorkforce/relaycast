import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../engine/command.js', () => ({
  registerCommand: vi.fn(),
  listCommands: vi.fn(),
  deleteCommand: vi.fn(),
  invokeCommand: vi.fn(),
}));

vi.mock('../../engine/channel.js', () => ({
  getChannel: vi.fn(),
}));

vi.mock('../../engine/agent.js', () => ({
  touchLastSeen: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../db/index.js', () => ({
  getDb: vi.fn(),
}));

import { Hono } from 'hono';
import type { AppEnv } from '../../env.js';
import { dbMiddleware } from '../../middleware/db.js';
import { commandRoutes } from '../../routes/command.js';
import { getDb } from '../../db/index.js';
import * as commandEngine from '../../engine/command.js';
import * as channelEngine from '../../engine/channel.js';
import {
  createMockBindings, mockDbForAgentAuth, mockDbForWorkspaceAuth,
  agentAuthHeaders, wsAuthHeaders,
  FAKE_WORKSPACE,
} from '../../__tests__/test-helpers.js';

const bindings = createMockBindings();

const app = new Hono<AppEnv>();
app.use('*', dbMiddleware);
const v1 = new Hono<AppEnv>();
v1.route('/', commandRoutes);
app.route('/v1', v1);

app.onError((err, c) => {
  const error = err as Error & { code?: string; status?: number };
  return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
});

// ── POST /v1/commands ──────────────────────────────────────────────────────

describe('POST /v1/commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
  });

  it('registers a command and returns 201', async () => {
    const cmd = {
      id: 'cmd_001',
      command: 'deploy',
      description: 'Deploy the app',
      handler_agent: 'DeployBot',
      parameters: [{ name: 'env', type: 'string', required: true }],
      workspace_id: 'ws_123',
      created_at: '2025-01-01T00:00:00.000Z',
    };
    vi.mocked(commandEngine.registerCommand).mockResolvedValue(cmd);

    const res = await app.request('/v1/commands', {
      method: 'POST',
      headers: wsAuthHeaders(),
      body: JSON.stringify({
        command: 'deploy',
        description: 'Deploy the app',
        handler_agent: 'DeployBot',
        parameters: [{ name: 'env', type: 'string', required: true }],
      }),
    }, bindings);

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data.command).toBe('deploy');
    expect(commandEngine.registerCommand).toHaveBeenCalledWith(
      expect.anything(),
      'ws_123',
      expect.objectContaining({ command: 'deploy', handler_agent: 'DeployBot' }),
    );
  });

  it('returns 400 when command name is missing', async () => {
    const res = await app.request('/v1/commands', {
      method: 'POST',
      headers: wsAuthHeaders(),
      body: JSON.stringify({ description: 'Deploy', handler_agent: 'Bot' }),
    }, bindings);

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('invalid_request');
  });

  it('returns 400 when description is missing', async () => {
    const res = await app.request('/v1/commands', {
      method: 'POST',
      headers: wsAuthHeaders(),
      body: JSON.stringify({ command: 'deploy', handler_agent: 'Bot' }),
    }, bindings);

    expect(res.status).toBe(400);
  });

  it('returns 400 when handler_agent is missing', async () => {
    const res = await app.request('/v1/commands', {
      method: 'POST',
      headers: wsAuthHeaders(),
      body: JSON.stringify({ command: 'deploy', description: 'Deploy' }),
    }, bindings);

    expect(res.status).toBe(400);
  });

  it('returns 401 without auth', async () => {
    const res = await app.request('/v1/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'deploy', description: 'Deploy', handler_agent: 'Bot' }),
    }, bindings);

    expect(res.status).toBe(401);
  });

  it('works with agent token (requireAuth accepts both)', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
    vi.mocked(commandEngine.registerCommand).mockResolvedValue({
      id: 'cmd_001',
      command: 'test',
      description: 'Test command',
      handler_agent: 'Bot',
      parameters: [],
      workspace_id: 'ws_123',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await app.request('/v1/commands', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({ command: 'test', description: 'Test command', handler_agent: 'Bot' }),
    }, bindings);

    expect(res.status).toBe(201);
  });

  it('propagates engine errors with correct status', async () => {
    vi.mocked(commandEngine.registerCommand).mockRejectedValue(
      Object.assign(new Error('Command "deploy" already exists'), {
        code: 'command_already_exists',
        status: 409,
      }),
    );

    const res = await app.request('/v1/commands', {
      method: 'POST',
      headers: wsAuthHeaders(),
      body: JSON.stringify({ command: 'deploy', description: 'Deploy', handler_agent: 'Bot' }),
    }, bindings);

    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error.code).toBe('command_already_exists');
  });
});

// ── GET /v1/commands ───────────────────────────────────────────────────────

describe('GET /v1/commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
  });

  it('lists commands and returns 200', async () => {
    vi.mocked(commandEngine.listCommands).mockResolvedValue([
      { id: 'cmd_001', command: 'deploy', description: 'Deploy', handler_agent: 'Bot', parameters: [], workspace_id: 'ws_123', created_at: '2025-01-01T00:00:00.000Z' },
    ]);

    const res = await app.request('/v1/commands', {
      headers: wsAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].command).toBe('deploy');
  });

  it('returns empty array when no commands', async () => {
    vi.mocked(commandEngine.listCommands).mockResolvedValue([]);

    const res = await app.request('/v1/commands', {
      headers: wsAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data).toEqual([]);
  });
});

// ── DELETE /v1/commands/:command ────────────────────────────────────────────

describe('DELETE /v1/commands/:command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
  });

  it('deletes a command and returns 204', async () => {
    vi.mocked(commandEngine.deleteCommand).mockResolvedValue(true);

    const res = await app.request('/v1/commands/deploy', {
      method: 'DELETE',
      headers: wsAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(204);
    expect(commandEngine.deleteCommand).toHaveBeenCalledWith(expect.anything(), 'ws_123', 'deploy');
  });

  it('returns 404 when command not found', async () => {
    vi.mocked(commandEngine.deleteCommand).mockResolvedValue(false);

    const res = await app.request('/v1/commands/nonexistent', {
      method: 'DELETE',
      headers: wsAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error.code).toBe('command_not_found');
  });
});

// ── POST /v1/commands/:command/invoke ───────────────────────────────────────

describe('POST /v1/commands/:command/invoke', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
  });

  it('invokes a command and returns 201', async () => {
    const result = {
      id: 'inv_001',
      command: 'deploy',
      channel: 'engineering',
      invoked_by: 'agent_123',
      args: '--force',
      parameters: {},
      created_at: '2025-01-01T00:00:00.000Z',
    };
    vi.mocked(commandEngine.invokeCommand).mockResolvedValue(result);
    vi.mocked(channelEngine.getChannel).mockResolvedValue({
      id: 'ch_001',
      name: 'engineering',
      workspaceId: 'ws_123',
      topic: null,
      archived: false,
      createdAt: new Date(),
      metadata: {},
    } as any);

    const res = await app.request('/v1/commands/deploy/invoke', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({ channel: 'engineering', args: '--force' }),
    }, bindings);

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data.command).toBe('deploy');
    expect(commandEngine.invokeCommand).toHaveBeenCalledWith(
      expect.anything(),
      'ws_123',
      'deploy',
      expect.objectContaining({ channel: 'engineering', invoked_by: 'agent_123' }),
    );
    expect(bindings.WEBHOOK_QUEUE.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'command.invoked',
      workspaceId: FAKE_WORKSPACE.id,
    }));
  });

  it('returns 400 when channel is missing', async () => {
    const res = await app.request('/v1/commands/deploy/invoke', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({ args: '--force' }),
    }, bindings);

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('invalid_request');
  });

  it('returns 403 when using workspace key instead of agent token', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());

    const res = await app.request('/v1/commands/deploy/invoke', {
      method: 'POST',
      headers: wsAuthHeaders(),
      body: JSON.stringify({ channel: 'engineering' }),
    }, bindings);

    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error.code).toBe('agent_token_required');
  });

  it('propagates engine error when command not found', async () => {
    vi.mocked(commandEngine.invokeCommand).mockRejectedValue(
      Object.assign(new Error('Command "nonexistent" not found'), {
        code: 'command_not_found',
        status: 404,
      }),
    );

    const res = await app.request('/v1/commands/nonexistent/invoke', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({ channel: 'engineering' }),
    }, bindings);

    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error.code).toBe('command_not_found');
  });

  it('still succeeds when channel lookup fails for fanout', async () => {
    const result = {
      id: 'inv_001',
      command: 'deploy',
      channel: 'engineering',
      invoked_by: 'agent_123',
      args: null,
      parameters: {},
      created_at: '2025-01-01T00:00:00.000Z',
    };
    vi.mocked(commandEngine.invokeCommand).mockResolvedValue(result);
    vi.mocked(channelEngine.getChannel).mockResolvedValue(null);

    const res = await app.request('/v1/commands/deploy/invoke', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({ channel: 'engineering' }),
    }, bindings);

    expect(res.status).toBe(201);
    // Webhook queue should still be called even if fanout channel lookup fails
    expect(bindings.WEBHOOK_QUEUE.send).toHaveBeenCalled();
  });
});
