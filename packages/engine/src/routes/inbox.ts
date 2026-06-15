import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { requireAgentToken } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as inboxEngine from '../engine/inbox.js';
import * as deliveryEngine from '../engine/delivery.js';
import { notifyDeliveryFailures } from './deliveryRouting.js';
import { runInBackground } from './background.js';
import { errorResponse } from '../lib/httpError.js';

export const inboxRoutes = new Hono<AppEnv>();

// GET /v1/inbox - unified inbox for the calling agent
inboxRoutes.get(
  '/inbox',
  requireAgentToken,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const agent = c.get('agent');
      const expired = await deliveryEngine.expireDueDeliveries(db, workspace.id);
      if (expired.length > 0) {
        runInBackground(c, notifyDeliveryFailures(c, expired), 'fanout delivery expired');
      }
      const result = await inboxEngine.getInbox(db, workspace.id, agent!.id);
      return c.json({ ok: true, data: result });
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);
