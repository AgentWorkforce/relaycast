import { Router, Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import * as webhooksEngine from '../engine/webhooks.js';

export const webhookRouter = Router();

function verifyWebhookSignature(body: string, signature: string, secret: string): boolean {
  // Stripe-compatible signature format: t=timestamp,v1=hash
  const parts = signature.split(',');
  const tPart = parts.find((p) => p.startsWith('t='));
  const vPart = parts.find((p) => p.startsWith('v1='));
  if (!tPart || !vPart) return false;

  const timestamp = tPart.slice(2);
  const sig = vPart.slice(3);
  if (!timestamp || !sig) return false;

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
      if (!signature || !verifyWebhookSignature(JSON.stringify(req.body), signature, webhookSecret)) {
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
  } catch {
    // Always return 200 for webhooks to prevent retries
    res.json({ ok: true, data: { received: true } });
  }
});
