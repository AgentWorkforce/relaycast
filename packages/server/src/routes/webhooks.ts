import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import * as webhooksEngine from '../engine/webhooks.js';

export const webhookRoutes = new Hono<AppEnv>();

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

webhookRoutes.post('/billing/webhooks', async (c) => {
  try {
    const db = c.get('db');
    const webhookSecret = c.env.STRIPE_WEBHOOK_SECRET;
    const rawBody = await c.req.text();

    if (webhookSecret) {
      const signature = c.req.header('stripe-signature');
      if (!signature || !verifyWebhookSignature(rawBody, signature, webhookSecret)) {
        return c.json({ ok: false, error: { code: 'invalid_signature', message: 'Invalid webhook signature' } }, 401);
      }
    }

    const body = JSON.parse(rawBody) as { type?: string; data?: Record<string, unknown> };
    const { type, data } = body;
    if (!type) {
      return c.json({ ok: false, error: { code: 'invalid_request', message: 'type is required' } }, 400);
    }
    const result = await webhooksEngine.processWebhook(db, { type, data: data || {} });
    return c.json({ ok: true, data: result });
  } catch (err) {
    // Return 500 so Stripe retries on processing failures
    return c.json({ ok: false, error: { code: 'webhook_processing_error', message: (err as Error).message } }, 500);
  }
});
