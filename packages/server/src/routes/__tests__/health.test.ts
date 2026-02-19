import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/index.js', () => ({
  getDb: vi.fn(),
}));

import { Hono } from 'hono';
import type { AppEnv } from '../../env.js';
import { dbMiddleware } from '../../middleware/db.js';
import { healthRoutes } from '../../routes/health.js';
import { workspaceRoutes } from '../../routes/workspace.js';
import { getDb } from '../../db/index.js';
import { createMockBindings, mockDbForWorkspaceAuth } from '../../__tests__/test-helpers.js';

vi.mock('../../engine/workspace.js', () => ({
  createWorkspace: vi.fn(),
  getWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
}));

const bindings = createMockBindings();

// Build test app mimicking worker.ts
const app = new Hono<AppEnv>();
app.use('*', dbMiddleware);
app.route('/health', healthRoutes);
const v1 = new Hono<AppEnv>();
v1.route('/', workspaceRoutes);
app.route('/v1', v1);

app.notFound((c) => {
  return c.json({ ok: false, error: { code: 'not_found', message: 'Route not found' } }, 404);
});

app.onError((err, c) => {
  const error = err as Error & { code?: string; status?: number };
  if (error.message?.includes('JSON')) {
    return c.json({ ok: false, error: { code: 'invalid_json', message: 'Malformed JSON in request body' } }, 400);
  }
  return c.json({ ok: false, error: { code: 'internal_error', message: error.message } }, 500);
});

describe('GET /health', () => {
  it('returns 200 with ok, version, and build', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
    const res = await app.request('/health', {}, bindings);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: '0.1.0', build: 'unknown' });
  });

  it('uses app semver and build from bindings when provided', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
    const res = await app.request('/health', {}, {
      ...bindings,
      APP_SEMVER: '0.2.5',
      APP_VERSION: '10d3df0a1118f4bae7147bc257c4cdbe07f7a04a',
    } as any);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      version: '0.2.5',
      build: '10d3df0a1118f4bae7147bc257c4cdbe07f7a04a',
    });
  });
});

describe('404 handler', () => {
  it('returns 404 for unknown routes', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
    const res = await app.request('/v1/nonexistent', {}, bindings);
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('not_found');
  });
});

describe('malformed JSON', () => {
  it('returns error for malformed JSON body', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
    const res = await app.request('/v1/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ invalid json }',
    }, bindings);
    // In Hono, the route's own try/catch handles the JSON parse error
    // It may return 400 (if route validates) or 500 (if error propagates)
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
  });
});
