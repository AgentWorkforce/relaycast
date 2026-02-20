import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../engine/file.js', () => ({
  createUpload: vi.fn(),
  completeUpload: vi.fn(),
  getFile: vi.fn(),
  deleteFile: vi.fn(),
  listFiles: vi.fn(),
  getS3Client: vi.fn().mockReturnValue({}),
}));

vi.mock('../../engine/agent.js', () => ({
  touchLastSeen: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../db/index.js', () => ({
  getDb: vi.fn(),
}));

vi.mock('../../lib/serverTelemetry.js', () => ({
  emitServerEvent: vi.fn(),
}));

import { Hono } from 'hono';
import type { AppEnv } from '../../env.js';
import { dbMiddleware } from '../../middleware/db.js';
import { fileRoutes } from '../../routes/file.js';
import * as fileEngine from '../../engine/file.js';
import { getDb } from '../../db/index.js';
import { emitServerEvent } from '../../lib/serverTelemetry.js';
import {
  mockDbForAgentAuth,
  mockDbForWorkspaceAuth,
  agentAuthHeaders,
  wsAuthHeaders,
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
v1.route('/', fileRoutes);
app.route('/v1', v1);

describe('POST /v1/files/upload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
  });

  it('returns 201 with upload URL', async () => {
    vi.mocked(fileEngine.createUpload).mockResolvedValue({
      id: 'file_001',
      upload_url: 'https://minio.local/presigned-put',
      expires_at: '2025-01-01T01:00:00.000Z',
    });

    const res = await app.request('/v1/files/upload', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({ filename: 'test.png', content_type: 'image/png', size_bytes: 1024 }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe('file_001');
    expect(body.data.upload_url).toBe('https://minio.local/presigned-put');
    expect(emitServerEvent).toHaveBeenCalledWith(
      expect.anything(),
      FAKE_WORKSPACE.id,
      'relaycast_server_file_upload_requested',
      expect.objectContaining({
        file_id: 'file_001',
      }),
    );
  });

  it('returns 400 when filename missing', async () => {
    const res = await app.request('/v1/files/upload', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({ content_type: 'image/png', size_bytes: 1024 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_request');
  });

  it('returns 400 when content_type missing', async () => {
    const res = await app.request('/v1/files/upload', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({ filename: 'test.png', size_bytes: 1024 }),
    });

    expect(res.status).toBe(400);
  });

  it('returns 400 when size_bytes missing', async () => {
    const res = await app.request('/v1/files/upload', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({ filename: 'test.png', content_type: 'image/png' }),
    });

    expect(res.status).toBe(400);
  });

  it('returns 401 without auth', async () => {
    const res = await app.request('/v1/files/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'test.png', content_type: 'image/png', size_bytes: 1024 }),
    });

    expect(res.status).toBe(401);
  });
});

describe('POST /v1/files/:id/complete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
  });

  it('returns 200 on success', async () => {
    vi.mocked(fileEngine.completeUpload).mockResolvedValue({
      id: 'file_001',
      download_url: 'https://minio.local/presigned-get',
      filename: 'test.png',
      content_type: 'image/png',
      size_bytes: 1024,
    });

    const res = await app.request('/v1/files/file_001/complete', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.download_url).toBe('https://minio.local/presigned-get');
    expect(bindings.WEBHOOK_QUEUE.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'file.uploaded',
      workspaceId: FAKE_WORKSPACE.id,
      data: expect.objectContaining({ id: 'file_001' }),
    }));
    expect(emitServerEvent).toHaveBeenCalledWith(
      expect.anything(),
      FAKE_WORKSPACE.id,
      'relaycast_server_file_upload_completed',
      expect.objectContaining({
        file_id: 'file_001',
      }),
    );
  });

  it('returns 404 when file not found', async () => {
    vi.mocked(fileEngine.completeUpload).mockResolvedValue(null);

    const res = await app.request('/v1/files/file_999/complete', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('file_not_found');
  });
});

describe('GET /v1/files/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 200 with file metadata', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
    vi.mocked(fileEngine.getFile).mockResolvedValue({
      id: 'file_001',
      filename: 'test.png',
      content_type: 'image/png',
      size_bytes: 1024,
      status: 'complete',
      uploaded_by: 'TestBot',
      download_url: 'https://minio.local/presigned-get',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await app.request('/v1/files/file_001', {
      method: 'GET',
      headers: agentAuthHeaders(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.filename).toBe('test.png');
  });

  it('returns 404 when file not found', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
    vi.mocked(fileEngine.getFile).mockResolvedValue(null);

    const res = await app.request('/v1/files/file_999', {
      method: 'GET',
      headers: agentAuthHeaders(),
    });

    expect(res.status).toBe(404);
  });

  it('works with workspace key', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
    vi.mocked(fileEngine.getFile).mockResolvedValue({
      id: 'file_001',
      filename: 'test.png',
      content_type: 'image/png',
      size_bytes: 1024,
      status: 'complete',
      uploaded_by: 'TestBot',
      download_url: 'https://minio.local/presigned-get',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await app.request('/v1/files/file_001', {
      method: 'GET',
      headers: wsAuthHeaders(),
    });

    expect(res.status).toBe(200);
  });
});

describe('DELETE /v1/files/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
  });

  it('returns 204 on success', async () => {
    vi.mocked(fileEngine.deleteFile).mockResolvedValue(true);

    const res = await app.request('/v1/files/file_001', {
      method: 'DELETE',
      headers: agentAuthHeaders(),
    });

    expect(res.status).toBe(204);
  });

  it('returns 404 when file not found', async () => {
    vi.mocked(fileEngine.deleteFile).mockResolvedValue(null);

    const res = await app.request('/v1/files/file_999', {
      method: 'DELETE',
      headers: agentAuthHeaders(),
    });

    expect(res.status).toBe(404);
  });

  it('returns 403 when not the file owner', async () => {
    vi.mocked(fileEngine.deleteFile).mockResolvedValue('forbidden');

    const res = await app.request('/v1/files/file_001', {
      method: 'DELETE',
      headers: agentAuthHeaders(),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('forbidden');
  });
});

describe('GET /v1/files', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 200 with file list', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
    vi.mocked(fileEngine.listFiles).mockResolvedValue([
      {
        id: 'file_001',
        filename: 'test.png',
        content_type: 'image/png',
        size_bytes: 1024,
        status: 'complete',
        created_at: '2025-01-01T00:00:00.000Z',
      },
    ]);

    const res = await app.request('/v1/files', {
      method: 'GET',
      headers: agentAuthHeaders(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
  });

  it('works with workspace key', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
    vi.mocked(fileEngine.listFiles).mockResolvedValue([]);

    const res = await app.request('/v1/files', {
      method: 'GET',
      headers: wsAuthHeaders(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
  });
});
