import { describe, expect, it, vi } from 'vitest';
import type { fetch as undiciFetch } from 'undici';
import { createNodeOutboundWebhookFetch, createNodeSafeWebhookFetch } from '../ssrf-fetch.js';

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

  it('uses the platform transport only for the exact configured egress proxy', async () => {
    const safeFetch = vi.fn(async () => new Response(null, { status: 204 }));
    const proxyFetch = vi.fn(async () => new Response(null, { status: 202 }));
    const outboundFetch = createNodeOutboundWebhookFetch(
      'http://egress.internal:8080/forward',
      safeFetch,
      proxyFetch,
    );

    await expect(outboundFetch('http://egress.internal:8080/forward'))
      .resolves.toMatchObject({ status: 202 });
    await expect(outboundFetch('https://8.8.8.8/webhook'))
      .resolves.toMatchObject({ status: 204 });

    expect(proxyFetch).toHaveBeenCalledTimes(1);
    expect(proxyFetch.mock.calls[0]?.[1]?.redirect).toBe('manual');
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });
});
