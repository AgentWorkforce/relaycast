import { afterEach, expect, it, vi } from 'vitest';
import { sendToExternalAgent } from '../a2a.js';

const payload = { jsonrpc: '2.0' as const, id: 'retry', method: 'message/send', params: { message: { message_id: 'retry', role: 'user' as const, parts: [{ kind: 'text' as const, text: 'hello' }] } } };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each(['TimeoutError', 'AbortError', 'TypeError'])('retries %s transport failures', async name => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockRejectedValueOnce(Object.assign(new Error('transport failed'), { name }))
    .mockResolvedValue(Response.json({ jsonrpc: '2.0', id: 'retry', result: {} }));
  vi.stubGlobal('fetch', fetch);
  const result = sendToExternalAgent('https://example.com', payload);
  const checked = expect(result).resolves.toMatchObject({ response: { id: 'retry' } });
  await vi.runAllTimersAsync(); await checked;
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('honors bounded Retry-After while staying within the 120-second claim', async () => {
  vi.useFakeTimers();
  const times: number[] = []; const start = Date.now();
  vi.stubGlobal('fetch', vi.fn(async () => { times.push(Date.now() - start); return new Response('', { status: 429, headers: { 'Retry-After': '3600' } }); }));
  const checked = expect(sendToExternalAgent('https://example.com', payload)).rejects.toMatchObject({ status: 429 });
  await vi.runAllTimersAsync(); await checked;
  expect(times).toEqual([0, 30_000, 60_000]);
  expect(60_000 + 3 * 15_000).toBeLessThan(120_000);
});

it('refuses credentialed HTTP before fetch and preserves unauthenticated HTTP', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ jsonrpc: '2.0', id: 'retry', result: {} }));
  vi.stubGlobal('fetch', fetch);
  await expect(sendToExternalAgent('http://example.com', payload, { scheme: 'bearer', credential: 'fixture-secret' })).rejects.toMatchObject({ code: 'a2a_agent_url_forbidden' });
  expect(fetch).not.toHaveBeenCalled();
  await sendToExternalAgent('http://example.com', payload);
  expect(fetch).toHaveBeenCalledTimes(1);
});
