import { Router, Response } from 'express';
import { requireWorkspaceKey, type AuthenticatedRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as workspaceEngine from '../engine/workspace.js';

export const workspaceRouter = Router();

// POST /v1/workspaces - create workspace (no auth required)
workspaceRouter.post('/workspaces', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== 'string') {
      res.status(400).json({
        ok: false,
        error: { code: 'invalid_request', message: 'name is required' },
      });
      return;
    }

    const result = await workspaceEngine.createWorkspace(name);
    res.status(201).json({ ok: true, data: result });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    const status = error.status || 500;
    res.status(status).json({
      ok: false,
      error: {
        code: error.code || 'internal_error',
        message: error.message,
      },
    });
  }
});

// GET /v1/workspace - get current workspace
workspaceRouter.get(
  '/workspace',
  requireWorkspaceKey,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const workspace = await workspaceEngine.getWorkspace(req.workspace!.id);
      if (!workspace) {
        res.status(404).json({
          ok: false,
          error: { code: 'workspace_not_found', message: 'Workspace not found' },
        });
        return;
      }
      res.json({ ok: true, data: workspace });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);

// PATCH /v1/workspace - update workspace
workspaceRouter.patch(
  '/workspace',
  requireWorkspaceKey,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const updated = await workspaceEngine.updateWorkspace(
        req.workspace!.id,
        req.body,
      );
      if (!updated) {
        res.status(404).json({
          ok: false,
          error: { code: 'workspace_not_found', message: 'Workspace not found' },
        });
        return;
      }
      res.json({ ok: true, data: updated });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);

// DELETE /v1/workspace - delete workspace
workspaceRouter.delete(
  '/workspace',
  requireWorkspaceKey,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      await workspaceEngine.deleteWorkspace(req.workspace!.id);
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
