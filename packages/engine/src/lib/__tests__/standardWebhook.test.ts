import { describe, expect, it } from 'vitest';
import {
  isValidStandardWebhookSecret,
  signStandardWebhook,
  verifyStandardWebhook,
} from '../standardWebhook.js';

// Generated with the official standardwebhooks JavaScript library from the
// same fixed 32-byte key, message id, timestamp, and raw body.
const secret = 'whsec_MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
const messageId = 'msg_2KWPBgLlAfxdpx2AI54pPJ85f4W';
const timestamp = '1674087231';
const body = '{"type":"contact.created","data":{"id":"contact_123"}}';
const officialSignature = 'v1,2/2R48vjDyZKtwwAWq4WVyy1FhutnxMXbRq6gLfXLhc=';

describe('Standard Webhooks signing', () => {
  it('matches the official library for a fixed test vector', async () => {
    await expect(signStandardWebhook(secret, messageId, timestamp, body))
      .resolves.toBe(officialSignature);
  });

  it('accepts any matching v1 signature during secret rotation', async () => {
    await expect(verifyStandardWebhook(
      secret,
      messageId,
      timestamp,
      body,
      `v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= ${officialSignature}`,
      { nowSeconds: Number(timestamp) },
    )).resolves.toBe(true);
  });

  it('rejects tampered bodies and malformed or undersized secrets', async () => {
    await expect(verifyStandardWebhook(
      secret,
      messageId,
      timestamp,
      `${body} `,
      officialSignature,
      { nowSeconds: Number(timestamp) },
    )).resolves.toBe(false);
    expect(isValidStandardWebhookSecret('shared-secret')).toBe(false);
    expect(isValidStandardWebhookSecret('whsec_YWJj')).toBe(false);
    expect(isValidStandardWebhookSecret(secret)).toBe(true);
  });

  it('rejects valid signatures outside the five-minute replay window', async () => {
    await expect(verifyStandardWebhook(
      secret,
      messageId,
      timestamp,
      body,
      officialSignature,
      { nowSeconds: Number(timestamp) + 301 },
    )).resolves.toBe(false);
  });
});
