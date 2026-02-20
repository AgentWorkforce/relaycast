import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../engine/systemPrompt.js', () => ({
  getSystemPrompt: vi.fn(),
  setSystemPrompt: vi.fn(),
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
import { systemPromptRoutes } from '../../routes/systemPrompt.js';
import * as systemPromptEngine from '../../engine/systemPrompt.js';
import { getDb } from '../../db/index.js';
import {
  mockDbForWorkspaceAuth,
  mockDbForAgentAuth,
  wsAuthHeaders,
  agentAuthHeaders,
  createMockBindings,
  FAKE_WORKSPACE,
} from '../../__tests__/test-helpers.js';

const bindings = createMockBindings();
const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  (c as any).env = { ...bindings };
  await next();
});
app.use('*', dbMiddleware);
const v1 = new Hono<AppEnv>();
v1.route('/', systemPromptRoutes);
app.route('/v1', v1);

describe('GET /v1/workspace/system-prompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns default prompt with workspace key auth', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
    vi.mocked(systemPromptEngine.getSystemPrompt).mockResolvedValue({
      prompt: 'You are an AI agent in a collaborative workspace.',
      is_default: true,
    });

    const res = await app.request('/v1/workspace/system-prompt', {
      method: 'GET',
      headers: wsAuthHeaders(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.prompt).toBe('You are an AI agent in a collaborative workspace.');
    expect(body.data.is_default).toBe(true);
  });

  it('works with agent token', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
    vi.mocked(systemPromptEngine.getSystemPrompt).mockResolvedValue({
      prompt: 'Custom prompt',
      is_default: false,
    });

    const res = await app.request('/v1/workspace/system-prompt', {
      method: 'GET',
      headers: agentAuthHeaders(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.prompt).toBe('Custom prompt');
    expect(body.data.is_default).toBe(false);
  });

  it('returns 401 without auth', async () => {
    const res = await app.request('/v1/workspace/system-prompt', { method: 'GET' });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });
});

describe('PUT /v1/workspace/system-prompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
  });

  it('sets custom prompt', async () => {
    vi.mocked(systemPromptEngine.setSystemPrompt).mockResolvedValue({
      prompt: 'You are a helpful coding assistant.',
      is_default: false,
    });

    const res = await app.request('/v1/workspace/system-prompt', {
      method: 'PUT',
      headers: wsAuthHeaders(),
      body: JSON.stringify({ prompt: 'You are a helpful coding assistant.' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.prompt).toBe('You are a helpful coding assistant.');
    expect(body.data.is_default).toBe(false);
    expect(systemPromptEngine.setSystemPrompt).toHaveBeenCalledWith(
      expect.anything(),
      FAKE_WORKSPACE.id,
      'You are a helpful coding assistant.',
    );
  });

  it('returns 400 for invalid prompt', async () => {
    const res = await app.request('/v1/workspace/system-prompt', {
      method: 'PUT',
      headers: wsAuthHeaders(),
      body: JSON.stringify({ prompt: 123 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('invalid_request');
  });

  it('reset=true resets to default', async () => {
    vi.mocked(systemPromptEngine.setSystemPrompt).mockResolvedValue({
      prompt: 'You are an AI agent in a collaborative workspace.',
      is_default: true,
    });

    const res = await app.request('/v1/workspace/system-prompt', {
      method: 'PUT',
      headers: wsAuthHeaders(),
      body: JSON.stringify({ reset: true }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.is_default).toBe(true);
    expect(systemPromptEngine.setSystemPrompt).toHaveBeenCalledWith(
      expect.anything(),
      FAKE_WORKSPACE.id,
      null,
    );
  });

  it('prompt=null resets to default', async () => {
    vi.mocked(systemPromptEngine.setSystemPrompt).mockResolvedValue({
      prompt: 'You are an AI agent in a collaborative workspace.',
      is_default: true,
    });

    const res = await app.request('/v1/workspace/system-prompt', {
      method: 'PUT',
      headers: wsAuthHeaders(),
      body: JSON.stringify({ prompt: null }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.is_default).toBe(true);
    expect(systemPromptEngine.setSystemPrompt).toHaveBeenCalledWith(
      expect.anything(),
      FAKE_WORKSPACE.id,
      null,
    );
  });

  it('returns 401 with agent token', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());

    const res = await app.request('/v1/workspace/system-prompt', {
      method: 'PUT',
      headers: agentAuthHeaders(),
      body: JSON.stringify({ prompt: 'hacked' }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });
});
