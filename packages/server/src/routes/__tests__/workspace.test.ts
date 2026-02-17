import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../engine/workspace.js', () => ({
  createWorkspace: vi.fn(),
  getWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  getDb: vi.fn(),
}));

import { Hono } from 'hono';
import type { AppEnv } from '../../env.js';
import { dbMiddleware } from '../../middleware/db.js';
import { workspaceRoutes } from '../../routes/workspace.js';
import { getDb } from '../../db/index.js';
import * as workspaceEngine from '../../engine/workspace.js';
import {
  TEST_API_KEY, FAKE_WORKSPACE,
  createMockBindings, mockDbForWorkspaceAuth, wsAuthHeaders,
} from '../../__tests__/test-helpers.js';

const bindings = createMockBindings();

const app = new Hono<AppEnv>();
app.use('*', dbMiddleware);
const v1 = new Hono<AppEnv>();
v1.route('/', workspaceRoutes);
app.route('/v1', v1);

app.onError((err, c) => {
  const error = err as Error & { code?: string; status?: number };
  if (error.message?.includes('JSON')) {
    return c.json({ ok: false, error: { code: 'invalid_json', message: 'Malformed JSON in request body' } }, 400);
  }
  return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
});

describe('POST /v1/workspaces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
  });

  it('creates a workspace and returns 201', async () => {
    vi.mocked(workspaceEngine.createWorkspace).mockResolvedValue({
      workspace_id: 'ws_456',
      api_key: 'rk_live_newkey123',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await app.request('/v1/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'my-project' }),
    }, bindings);

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data.workspace_id).toBe('ws_456');
    expect(body.data.api_key).toContain('rk_live_');
  });

  it('returns 400 when name is missing', async () => {
    const res = await app.request('/v1/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, bindings);
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('invalid_request');
  });

  it('returns 409 for duplicate workspace name', async () => {
    vi.mocked(workspaceEngine.createWorkspace).mockRejectedValue(
      Object.assign(new Error('Workspace "my-project" already exists'), {
        code: 'workspace_already_exists',
        status: 409,
      }),
    );

    const res = await app.request('/v1/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'my-project' }),
    }, bindings);
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error.code).toBe('workspace_already_exists');
  });
});

describe('GET /v1/workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
  });

  it('returns workspace data with valid key', async () => {
    vi.mocked(workspaceEngine.getWorkspace).mockResolvedValue({
      id: 'ws_123',
      name: 'test-workspace',
      plan: 'free',
      system_prompt: null,
      created_at: '2025-01-01T00:00:00.000Z',
      metadata: {},
    });

    const res = await app.request('/v1/workspace', {
      headers: wsAuthHeaders(),
    }, bindings);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data.name).toBe('test-workspace');
  });

  it('returns 401 without auth', async () => {
    const res = await app.request('/v1/workspace', {}, bindings);
    expect(res.status).toBe(401);
  });
});

describe('PATCH /v1/workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
  });

  it('updates workspace', async () => {
    vi.mocked(workspaceEngine.updateWorkspace).mockResolvedValue({
      id: 'ws_123',
      name: 'new-name',
      plan: 'free',
      system_prompt: null,
      created_at: '2025-01-01T00:00:00.000Z',
      metadata: {},
    });

    const res = await app.request('/v1/workspace', {
      method: 'PATCH',
      headers: wsAuthHeaders(),
      body: JSON.stringify({ name: 'new-name' }),
    }, bindings);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.name).toBe('new-name');
  });
});

describe('DELETE /v1/workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
  });

  it('deletes workspace and returns 204', async () => {
    vi.mocked(workspaceEngine.deleteWorkspace).mockResolvedValue(undefined);

    const res = await app.request('/v1/workspace', {
      method: 'DELETE',
      headers: wsAuthHeaders(),
    }, bindings);
    expect(res.status).toBe(204);
  });
});
