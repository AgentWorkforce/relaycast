import { Router, Response } from 'express';
import {
  requireAuth,
  requireAgentToken,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as fileEngine from '../engine/file.js';
import { publishEvent } from '../ws/pubsub.js';
import { deliverEvent } from '../engine/eventDelivery.js';

export const fileRouter = Router();

// POST /v1/files/upload — Returns presigned PUT URL
fileRouter.post(
  '/files/upload',
  requireAgentToken,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { filename, content_type, size_bytes } = req.body;
      if (!filename || typeof filename !== 'string') {
        res.status(400).json({
          ok: false,
          error: { code: 'invalid_request', message: 'filename is required' },
        });
        return;
      }
      if (!content_type || typeof content_type !== 'string') {
        res.status(400).json({
          ok: false,
          error: { code: 'invalid_request', message: 'content_type is required' },
        });
        return;
      }
      if (!size_bytes || typeof size_bytes !== 'number') {
        res.status(400).json({
          ok: false,
          error: { code: 'invalid_request', message: 'size_bytes is required' },
        });
        return;
      }

      const result = await fileEngine.createUpload(
        req.workspace!.id,
        req.agent!.id,
        { filename, content_type, size_bytes },
      );

      res.status(201).json({ ok: true, data: result });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);

// POST /v1/files/:id/complete — Complete upload
fileRouter.post(
  '/files/:id/complete',
  requireAgentToken,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await fileEngine.completeUpload(
        req.workspace!.id,
        req.params.id as string,
        req.agent!.id,
      );
      if (!result) {
        res.status(404).json({
          ok: false,
          error: { code: 'file_not_found', message: 'File not found or not owned by you' },
        });
        return;
      }

      res.status(200).json({ ok: true, data: result });

      // Fire-and-forget event publishing
      const eventData = { ...result, agent_id: req.agent!.id };
      publishEvent({ type: 'file.uploaded', workspace_id: req.workspace!.id, data: eventData, timestamp: new Date().toISOString() }).catch(() => {});
      deliverEvent(req.workspace!.id, 'file.uploaded', eventData).catch(() => {});
    } catch (err: unknown) {
      if (!res.headersSent) {
        const error = err as Error & { code?: string; status?: number };
        res.status(error.status || 500).json({
          ok: false,
          error: { code: error.code || 'internal_error', message: error.message },
        });
      }
    }
  },
);

// GET /v1/files/:id — Get file metadata
fileRouter.get(
  '/files/:id',
  requireAuth,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await fileEngine.getFile(
        req.workspace!.id,
        req.params.id as string,
      );
      if (!result) {
        res.status(404).json({
          ok: false,
          error: { code: 'file_not_found', message: 'File not found' },
        });
        return;
      }

      res.json({ ok: true, data: result });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);

// DELETE /v1/files/:id — Soft delete
fileRouter.delete(
  '/files/:id',
  requireAgentToken,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await fileEngine.deleteFile(
        req.workspace!.id,
        req.params.id as string,
        req.agent!.id,
      );
      if (result === null) {
        res.status(404).json({
          ok: false,
          error: { code: 'file_not_found', message: 'File not found' },
        });
        return;
      }
      if (result === 'forbidden') {
        res.status(403).json({
          ok: false,
          error: { code: 'forbidden', message: 'Not the file owner' },
        });
        return;
      }

      res.status(204).send();
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);

// GET /v1/files — List files
fileRouter.get(
  '/files',
  requireAuth,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const uploaded_by = req.query.uploaded_by as string | undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

      const result = await fileEngine.listFiles(req.workspace!.id, {
        uploaded_by,
        limit,
      });

      res.json({ ok: true, data: result });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);
