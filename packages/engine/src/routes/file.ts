import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { errorResponse } from '../lib/httpError.js';
import {
  jsonCreated,
  jsonError,
  jsonNoContent,
  jsonNotFound,
  jsonOk,
  parseJsonBody,
  parseQueryParams,
} from '../lib/httpResponse.js';
import { LimitQuerySchema } from '../lib/httpQuery.js';
import { requireWorkspaceRead, requireAgentToken } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as fileEngine from '../engine/file.js';
import { fanoutToWorkspace } from './fanout.js';
import { runInBackground } from './background.js';
import { sendWebhookEvent } from './webhookOutbox.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';

export const fileRoutes = new Hono<AppEnv>();

const fileUploadSchema = z.object({
  filename: z.string().min(1),
  content_type: z.string().min(1),
  size_bytes: z.number().finite().refine((value) => value !== 0),
});

const listFilesQuerySchema = LimitQuerySchema.extend({
  uploaded_by: z.string().optional(),
});

type ValidationFailure = { error: { issues: Array<{ path: PropertyKey[] }> } };

function uploadInvalidMessage(failure: ValidationFailure) {
  const hasFilenameIssue = failure.error.issues.some((issue) => issue.path[0] === 'filename');
  const hasContentTypeIssue = failure.error.issues.some((issue) => issue.path[0] === 'content_type');
  const hasSizeBytesIssue = failure.error.issues.some((issue) => issue.path[0] === 'size_bytes');
  return hasFilenameIssue
    ? 'filename is required'
    : hasContentTypeIssue
      ? 'content_type is required'
      : hasSizeBytesIssue
        ? 'size_bytes is required'
        : 'invalid upload body';
}

// POST /v1/files/upload — Returns presigned PUT URL
fileRoutes.post('/files/upload', requireAgentToken, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const agent = c.get('agent')!;
    const storage = c.get('engine').files;
    const parsed = await parseJsonBody(c, fileUploadSchema, uploadInvalidMessage);
    if (!parsed.ok) {
      return parsed.response;
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

    return jsonCreated(c, result);
  } catch (err: unknown) {
    return errorResponse(c, err);
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
      return jsonNotFound(c, 'file_not_found', 'File not found or not owned by you');
    }

    const eventData = { ...result, agent_id: agent.id };
    runInBackground(c, fanoutToWorkspace(c, 'file.uploaded', eventData), 'fanout file.uploaded');
    await sendWebhookEvent(c, {
      type: 'file.uploaded',
      workspaceId: workspace.id,
      data: { ...result, uploaded_by_name: agent.name },
    });
    emitServerEvent(c, workspace.id, 'relaycast_server_file_upload_completed', {
      file_id: result.id,
      size_bytes: result.size_bytes,
      content_type: result.content_type,
    });

    return jsonOk(c, result);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// GET /v1/files/:id — Get file metadata
fileRoutes.get('/files/:id', requireWorkspaceRead('files:read'), rateLimit, async (c) => {
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
      return jsonNotFound(c, 'file_not_found', 'File not found');
    }

    return jsonOk(c, result);
  } catch (err: unknown) {
    return errorResponse(c, err);
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
      return jsonNotFound(c, 'file_not_found', 'File not found');
    }
    if (result === 'forbidden') {
      return jsonError(c, 'forbidden', 'Not the file owner', 403);
    }

    return jsonNoContent(c);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// GET /v1/files — List files
fileRoutes.get('/files', requireWorkspaceRead('files:read'), rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');

    const parsed = parseQueryParams(c, listFilesQuerySchema, 'Invalid file list query');
    if (!parsed.ok) {
      return parsed.response;
    }
    const { uploaded_by, limit } = parsed.data;

    const result = await fileEngine.listFiles(db, workspace.id, {
      uploaded_by,
      limit,
    });

    return jsonOk(c, result);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});
