import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireAuth, requireAgentToken } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as fileEngine from '../engine/file.js';
import { fanoutToWorkspace } from './fanout.js';
import { runInBackground } from './background.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';

export const fileRoutes = new Hono<AppEnv>();

const fileUploadSchema = z.object({
  filename: z.string().min(1),
  content_type: z.string().min(1),
  size_bytes: z.number().finite().refine((value) => value !== 0),
});

// POST /v1/files/upload — Returns presigned PUT URL
fileRoutes.post('/files/upload', requireAgentToken, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const agent = c.get('agent')!;
    const storage = c.get('engine').files;
    const parsed = fileUploadSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      const hasFilenameIssue = parsed.error.issues.some((issue) => issue.path[0] === 'filename');
      const hasContentTypeIssue = parsed.error.issues.some((issue) => issue.path[0] === 'content_type');
      const hasSizeBytesIssue = parsed.error.issues.some((issue) => issue.path[0] === 'size_bytes');
      const message = hasFilenameIssue
        ? 'filename is required'
        : hasContentTypeIssue
          ? 'content_type is required'
          : hasSizeBytesIssue
            ? 'size_bytes is required'
            : 'invalid upload body';
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message },
      }, 400);
    }
    const { filename, content_type, size_bytes } = parsed.data;

    const result = await fileEngine.createUpload(
      db,
      storage,
      workspace.id,
      agent.id,
      { filename, content_type, size_bytes },
    );

    emitServerEvent(c, workspace.id, 'relaycast_server_file_upload_requested', {
      file_id: result.id,
      size_bytes,
      content_type,
    });

    return c.json({ ok: true, data: result }, 201);
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as ContentfulStatusCode);
  }
});

// POST /v1/files/:id/complete — Complete upload
fileRoutes.post('/files/:id/complete', requireAgentToken, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const agent = c.get('agent')!;
    const storage = c.get('engine').files;

    const result = await fileEngine.completeUpload(
      db,
      storage,
      workspace.id,
      c.req.param('id'),
      agent.id,
    );
    if (!result) {
      return c.json({
        ok: false,
        error: { code: 'file_not_found', message: 'File not found or not owned by you' },
      }, 404);
    }

    const eventData = { ...result, agent_id: agent.id };
    runInBackground(c, fanoutToWorkspace(c, 'file.uploaded', eventData), 'fanout file.uploaded');
    runInBackground(
      c,
      c.get('engine').webhookQueue.send({
        type: 'file.uploaded',
        workspaceId: workspace.id,
        data: { ...result, uploaded_by_name: agent.name },
      }),
      'queue file.uploaded',
    );
    emitServerEvent(c, workspace.id, 'relaycast_server_file_upload_completed', {
      file_id: result.id,
      size_bytes: result.size_bytes,
      content_type: result.content_type,
    });

    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as ContentfulStatusCode);
  }
});

// GET /v1/files/:id — Get file metadata
fileRoutes.get('/files/:id', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const storage = c.get('engine').files;

    const result = await fileEngine.getFile(
      db,
      storage,
      workspace.id,
      c.req.param('id'),
    );
    if (!result) {
      return c.json({
        ok: false,
        error: { code: 'file_not_found', message: 'File not found' },
      }, 404);
    }

    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as ContentfulStatusCode);
  }
});

// DELETE /v1/files/:id — Soft delete
fileRoutes.delete('/files/:id', requireAgentToken, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const agent = c.get('agent')!;

    const result = await fileEngine.deleteFile(
      db,
      workspace.id,
      c.req.param('id'),
      agent.id,
    );
    if (result === null) {
      return c.json({
        ok: false,
        error: { code: 'file_not_found', message: 'File not found' },
      }, 404);
    }
    if (result === 'forbidden') {
      return c.json({
        ok: false,
        error: { code: 'forbidden', message: 'Not the file owner' },
      }, 403);
    }

    return c.body(null, 204);
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as ContentfulStatusCode);
  }
});

// GET /v1/files — List files
fileRoutes.get('/files', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');

    const uploaded_by = c.req.query('uploaded_by');
    const limitStr = c.req.query('limit');
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;

    const result = await fileEngine.listFiles(db, workspace.id, {
      uploaded_by,
      limit,
    });

    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as ContentfulStatusCode);
  }
});
