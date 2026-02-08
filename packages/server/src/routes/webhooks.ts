import { Router, Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import * as webhooksEngine from '../engine/webhooks.js';

export const webhookRouter = Router();

const WEBHOOK_TOLERANCE_SECONDS = 300; // 5 minutes

function verifyWebhookSignature(body: string, signature: string, secret: string): boolean {
  // Stripe-compatible signature format: t=timestamp,v1=hash
  const parts = signature.split(',');
  const tPart = parts.find((p) => p.startsWith('t='));
  const vPart = parts.find((p) => p.startsWith('v1='));
  if (!tPart || !vPart) return false;

  const timestamp = tPart.slice(2);
  const sig = vPart.slice(3);
  if (!timestamp || !sig) return false;

  // Reject stale signatures to prevent replay attacks
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > WEBHOOK_TOLERANCE_SECONDS) {
    return false;
  }

  const signedPayload = `${timestamp}.${body}`;
  const expected = createHmac('sha256', secret).update(signedPayload).digest('hex');

  try {
    return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

webhookRouter.post('/billing/webhooks', async (req: Request, res: Response) => {
  try {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (webhookSecret) {
      const signature = req.headers['stripe-signature'] as string | undefined;
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody?.toString() ?? JSON.stringify(req.body);
      if (!signature || !verifyWebhookSignature(rawBody, signature, webhookSecret)) {
        res.status(401).json({ ok: false, error: { code: 'invalid_signature', message: 'Invalid webhook signature' } });
        return;
      }
    }

    const { type, data } = req.body as { type?: string; data?: Record<string, unknown> };
    if (!type) {
      res.status(400).json({ ok: false, error: { code: 'invalid_request', message: 'type is required' } });
      return;
    }
    const result = await webhooksEngine.processWebhook({ type, data: data || {} });
    res.json({ ok: true, data: result });
  } catch (err) {
    // Return 500 so Stripe retries on processing failures
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: { code: 'webhook_processing_error', message: (err as Error).message } });
    }
  }
});
