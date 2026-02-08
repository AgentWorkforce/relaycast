import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';

const { mockGetActiveSubscriptions, mockFetch } = vi.hoisted(() => ({
  mockGetActiveSubscriptions: vi.fn(),
  mockFetch: vi.fn(),
}));

vi.mock('../engine/eventSubscription.js', () => ({
  getActiveSubscriptions: mockGetActiveSubscriptions,
}));

// Mock global fetch
vi.stubGlobal('fetch', mockFetch);

import { signPayload, deliverEvent } from '../engine/eventDelivery.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockResolvedValue({ ok: true, status: 200 });
});

describe('signPayload', () => {
  it('produces a valid HMAC-SHA256 hex digest', () => {
    const payload = '{"type":"message.created","data":{}}';
    const secret = 'whsec_test123';

    const result = signPayload(payload, secret);

    const expected = createHmac('sha256', secret).update(payload).digest('hex');
    expect(result).toBe(expected);
  });

  it('produces different signatures for different secrets', () => {
    const payload = '{"data":"same"}';
    const sig1 = signPayload(payload, 'secret1');
    const sig2 = signPayload(payload, 'secret2');
    expect(sig1).not.toBe(sig2);
  });

  it('produces different signatures for different payloads', () => {
    const secret = 'same_secret';
    const sig1 = signPayload('payload1', secret);
    const sig2 = signPayload('payload2', secret);
    expect(sig1).not.toBe(sig2);
  });
});

describe('deliverEvent', () => {
  it('does nothing when no subscriptions exist', async () => {
    mockGetActiveSubscriptions.mockResolvedValue([]);

    await deliverEvent('ws_1', 'message.created', { text: 'hello' });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('delivers to a subscription without secret', async () => {
    mockGetActiveSubscriptions.mockResolvedValue([
      { url: 'https://example.com/hook', secret: null, filter: null },
    ]);

    await deliverEvent('ws_1', 'message.created', { text: 'hello' });

    // Allow async fire-and-forget to settle
    await new Promise((r) => setTimeout(r, 50));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://example.com/hook');
    expect(opts.method).toBe('POST');

    const headers = opts.headers;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Relay-Event']).toBe('message.created');
    expect(headers['X-Relay-Timestamp']).toBeDefined();
    expect(headers['X-Relay-Signature']).toBeUndefined();

    const body = JSON.parse(opts.body);
    expect(body.type).toBe('message.created');
    expect(body.workspace_id).toBe('ws_1');
    expect(body.data.text).toBe('hello');
  });

  it('includes HMAC signature when subscription has a secret', async () => {
    mockGetActiveSubscriptions.mockResolvedValue([
      { url: 'https://example.com/hook', secret: 'whsec_abc123', filter: null },
    ]);

    await deliverEvent('ws_1', 'message.created', { text: 'hello' });
    await new Promise((r) => setTimeout(r, 50));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['X-Relay-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);

    // Verify the signature is correct
    const body = mockFetch.mock.calls[0][1].body;
    const expectedSig = `sha256=${signPayload(body, 'whsec_abc123')}`;
    expect(headers['X-Relay-Signature']).toBe(expectedSig);
  });

  it('delivers to multiple subscriptions', async () => {
    mockGetActiveSubscriptions.mockResolvedValue([
      { url: 'https://a.com/hook', secret: null, filter: null },
      { url: 'https://b.com/hook', secret: null, filter: null },
    ]);

    await deliverEvent('ws_1', 'message.created', { text: 'hello' });
    await new Promise((r) => setTimeout(r, 50));

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('filters by channel name', async () => {
    mockGetActiveSubscriptions.mockResolvedValue([
      { url: 'https://a.com/hook', secret: null, filter: { channel: 'alerts' } },
    ]);

    // Message in a different channel should not trigger delivery
    await deliverEvent('ws_1', 'message.created', { text: 'hello', channel_name: 'general' });
    await new Promise((r) => setTimeout(r, 50));

    expect(mockFetch).not.toHaveBeenCalled();

    // Message in matching channel should trigger delivery
    await deliverEvent('ws_1', 'message.created', { text: 'hello', channel_name: 'alerts' });
    await new Promise((r) => setTimeout(r, 50));

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects events with no channel info when channel filter is set', async () => {
    mockGetActiveSubscriptions.mockResolvedValue([
      { url: 'https://a.com/hook', secret: null, filter: { channel: 'alerts' } },
    ]);

    // DM event has no channel_name — should NOT pass the channel filter
    await deliverEvent('ws_1', 'dm.received', { text: 'hello', to: 'bob' });
    await new Promise((r) => setTimeout(r, 50));

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('filters by mentions', async () => {
    mockGetActiveSubscriptions.mockResolvedValue([
      { url: 'https://a.com/hook', secret: null, filter: { mentions: 'alice' } },
    ]);

    // No mention
    await deliverEvent('ws_1', 'message.created', { text: 'hello world' });
    await new Promise((r) => setTimeout(r, 50));
    expect(mockFetch).not.toHaveBeenCalled();

    // With mention
    await deliverEvent('ws_1', 'message.created', { text: 'hey @alice check this' });
    await new Promise((r) => setTimeout(r, 50));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not throw when getActiveSubscriptions fails', async () => {
    mockGetActiveSubscriptions.mockRejectedValue(new Error('DB error'));

    // Should not throw
    await expect(deliverEvent('ws_1', 'message.created', { text: 'hello' })).resolves.toBeUndefined();
  });

  it('does not throw when fetch fails', async () => {
    mockGetActiveSubscriptions.mockResolvedValue([
      { url: 'https://down.com/hook', secret: null, filter: null },
    ]);
    mockFetch.mockRejectedValue(new Error('Network error'));

    // Should not throw
    await expect(deliverEvent('ws_1', 'message.created', { text: 'hello' })).resolves.toBeUndefined();
  });

  it('does not retry on 4xx errors', async () => {
    mockGetActiveSubscriptions.mockResolvedValue([
      { url: 'https://a.com/hook', secret: null, filter: null },
    ]);
    mockFetch.mockResolvedValue({ ok: false, status: 400 });

    await deliverEvent('ws_1', 'message.created', { text: 'hello' });
    await new Promise((r) => setTimeout(r, 200));

    // Only one attempt, no retries
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
