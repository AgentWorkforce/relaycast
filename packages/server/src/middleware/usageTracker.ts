import { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from './auth.js';
import { incrementUsage } from '../engine/usage.js';

export async function usageTracker(req: AuthenticatedRequest, _res: Response, next: NextFunction): Promise<void> {
  if (req.workspace) {
    incrementUsage(req.workspace.id, 'api_calls').catch(() => {});
  }
  next();
}
