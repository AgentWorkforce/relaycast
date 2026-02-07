import { Router, Request, Response } from 'express';
import * as webhooksEngine from '../engine/webhooks.js';

export const webhookRouter = Router();

webhookRouter.post('/billing/webhooks', async (req: Request, res: Response) => {
  try {
    const { type, data } = req.body as { type?: string; data?: Record<string, unknown> };
    if (!type) {
      res.status(400).json({ ok: false, error: { code: 'invalid_request', message: 'type is required' } });
      return;
    }
    const result = await webhooksEngine.processWebhook({ type, data: data || {} });
    res.json({ ok: true, data: result });
  } catch {
    // Always return 200 for webhooks to prevent retries
    res.json({ ok: true, data: { received: true } });
  }
});
