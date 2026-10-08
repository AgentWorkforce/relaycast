import { describe, expect, it } from 'vitest';
import { verifyStandardWebhook } from '../../lib/standardWebhook.js';
import { buildHttpPushHeaders } from '../httpPushDispatch.js';

const secret = 'whsec_MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

describe('buildHttpPushHeaders', () => {
  it('opts hmac_sha256 auth into Standard Webhooks signing', async () => {
    const body = '{"type":"message.created"}';
    const headers = await buildHttpPushHeaders({
      auth: { type: 'hmac_sha256', secret, signature_scheme: 'standard-webhooks' },
    }, 'message.created', 'delivery_123', body, '2026-10-08T12:00:00.000Z');

    expect(headers['webhook-id']).toBe('delivery_123');
    expect(headers['webhook-timestamp']).toBe('1791460800');
    expect(headers['X-Relaycast-Signature']).toBeUndefined();
    await expect(verifyStandardWebhook(
      secret,
      headers['webhook-id'],
      headers['webhook-timestamp'],
      body,
      headers['webhook-signature'],
      { nowSeconds: Number(headers['webhook-timestamp']) },
    )).resolves.toBe(true);
  });

  it('keeps legacy HMAC as the default while adding a stable webhook id', async () => {
    const headers = await buildHttpPushHeaders({
      auth: { type: 'hmac_sha256', secret: 'legacy-secret' },
    }, 'message.created', 'delivery_legacy', '{}', '2026-10-08T12:00:00.000Z');

    expect(headers['webhook-id']).toBe('delivery_legacy');
    expect(headers['X-Relaycast-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(headers['webhook-signature']).toBeUndefined();
  });
});
