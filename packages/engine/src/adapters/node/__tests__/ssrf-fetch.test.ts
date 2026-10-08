import { describe, expect, it, vi } from 'vitest';
import type { fetch as undiciFetch } from 'undici';
import { createNodeSafeWebhookFetch } from '../ssrf-fetch.js';

describe('createNodeSafeWebhookFetch', () => {
  it('preserves Request method, headers, body, and signal', async () => {
    const transport = vi.fn(async () => new Response(null, { status: 204 }));
    const safeFetch = createNodeSafeWebhookFetch(transport as unknown as typeof undiciFetch);
    const controller = new AbortController();
    const request = new Request('https://8.8.8.8/webhook', {
      method: 'POST',
      headers: { 'x-test': 'preserved' },
      body: 'payload',
      signal: controller.signal,
    });

    await safeFetch(request);

    expect(transport).toHaveBeenCalledTimes(1);
    const [forwarded, init] = transport.mock.calls[0] as unknown as [Request, RequestInit];
    expect(forwarded).toBe(request);
    expect(forwarded.method).toBe('POST');
    expect(forwarded.headers.get('x-test')).toBe('preserved');
    expect(forwarded.signal.aborted).toBe(false);
    controller.abort();
    expect(forwarded.signal.aborted).toBe(true);
    await expect(forwarded.clone().text()).resolves.toBe('payload');
    expect(init.redirect).toBe('manual');
  });
});
