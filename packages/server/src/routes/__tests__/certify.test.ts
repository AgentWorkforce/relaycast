import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/index.js', () => ({
  getDb: vi.fn(),
}));

vi.mock('../../engine/certify.js', async () => {
  const actual = await vi.importActual<typeof import('../../engine/certify.js')>('../../engine/certify.js');
  return {
    ...actual,
    createAndRunCertification: vi.fn(),
    getCertificationRun: vi.fn(),
    enableCertificationMonitoring: vi.fn(),
    badgeSvg: vi.fn(),
  };
});

vi.mock('../../engine/agent.js', () => ({
  touchLastSeen: vi.fn().mockResolvedValue(undefined),
}));

import { Hono } from 'hono';
import type { AppEnv } from '../../env.js';
import { dbMiddleware } from '../../middleware/db.js';
import { certifyRoutes } from '../../routes/certify.js';
import { getDb } from '../../db/index.js';
import * as certifyEngine from '../../engine/certify.js';
import {
  createMockBindings,
  mockDbForWorkspaceAuth,
  wsAuthHeaders,
} from '../../__tests__/test-helpers.js';

const bindings = createMockBindings();

const app = new Hono<AppEnv>();
app.use('*', dbMiddleware);
const v1 = new Hono<AppEnv>();
v1.route('/', certifyRoutes);
app.route('/v1', v1);

app.onError((err, c) => {
  const error = err as Error & { code?: string; status?: number };
  return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
});

describe('certify routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
  });

  it('submits a certification run', async () => {
    vi.mocked(certifyEngine.createAndRunCertification).mockResolvedValue({
      id: 'cert_1',
      agent_url: 'https://agent.example.com/a2a/rpc',
      level: 1,
      passed: true,
      passed_tests: 6,
      total_tests: 6,
      started_at: '2026-01-01T00:00:00.000Z',
      completed_at: '2026-01-01T00:00:01.000Z',
      tests: [],
    } as any);

    const res = await app.request('/v1/certify', {
      method: 'POST',
      headers: wsAuthHeaders(),
      body: JSON.stringify({
        agent_url: 'https://agent.example.com/a2a/rpc',
        level: 1,
      }),
    }, bindings);

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe('cert_1');
  });

  it('returns stored certification results', async () => {
    vi.mocked(certifyEngine.getCertificationRun).mockResolvedValue({
      id: 'cert_1',
      passed: true,
      passed_tests: 6,
      total_tests: 6,
      tests: [],
    } as any);

    const res = await app.request('/v1/certify/cert_1', {
      headers: wsAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe('cert_1');
  });

  it('returns badge svg', async () => {
    vi.mocked(certifyEngine.getCertificationRun).mockResolvedValue({
      id: 'cert_1',
      passed: true,
      level: 1,
      passed_tests: 6,
      total_tests: 6,
      status: 'completed',
    } as any);
    vi.mocked(certifyEngine.badgeSvg).mockReturnValue('<svg></svg>');

    const res = await app.request('/v1/certify/cert_1/badge.svg', {
      headers: wsAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/svg+xml');
    expect(await res.text()).toBe('<svg></svg>');
  });

  it('enables monitoring', async () => {
    vi.mocked(certifyEngine.enableCertificationMonitoring).mockResolvedValue({
      id: 'cert_monitor_1',
      monitor_enabled: true,
    } as any);

    const res = await app.request('/v1/certify/monitor', {
      method: 'POST',
      headers: wsAuthHeaders(),
      body: JSON.stringify({
        agent_url: 'https://agent.example.com/a2a/rpc',
        level: 2,
        interval_minutes: 30,
      }),
    }, bindings);

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe('cert_monitor_1');
  });
});
