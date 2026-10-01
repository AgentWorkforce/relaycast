import { afterEach, expect, it, vi } from 'vitest';
import { sendToExternalAgent } from '../a2a.js';

const payload = { jsonrpc: '2.0' as const, id: 'retry', method: 'message/send', params: { message: { message_id: 'retry', role: 'user' as const, parts: [{ kind: 'text' as const, text: 'hello' }] } } };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('retries a lost transport response', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockRejectedValueOnce(new Error('transport failed'))
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
  expect(Date.now() - start).toBeLessThan(120_000);
});

it('refuses credentialed HTTP before fetch and preserves unauthenticated HTTP', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ jsonrpc: '2.0', id: 'retry', result: {} }));
  vi.stubGlobal('fetch', fetch);
  await expect(sendToExternalAgent('http://example.com', payload, { scheme: 'bearer', credential: 'fixture-secret' })).rejects.toMatchObject({ code: 'a2a_agent_url_forbidden' });
  expect(fetch).not.toHaveBeenCalled();
  await sendToExternalAgent('http://example.com', payload);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('keeps the egress header and body identity on retries after current-tuple validation', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockRejectedValueOnce(new Error('remote accepted but response was lost'))
    .mockResolvedValue(Response.json({ jsonrpc: '2.0', id: 'retry', result: {} }));
  const validate = vi.fn().mockResolvedValue({ scheme: 'bearer', credential: 'current-token' });
  vi.stubGlobal('fetch', fetch);
  const result = sendToExternalAgent('https://example.com', payload, undefined, validate, 'a2ae_stable');
  const checked = expect(result).resolves.toMatchObject({ response: { id: 'retry' } });
  await vi.runAllTimersAsync(); await checked;
  expect(validate).toHaveBeenCalledTimes(2);
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const [, init] of fetch.mock.calls) {
    expect(init.headers).toMatchObject({ 'Idempotency-Key': 'a2ae_stable', authorization: 'Bearer current-token' });
    expect(JSON.parse(init.body)).toEqual(payload);
  }
});

it('does not fetch with the egress header when current tuple or credentialed URL validation fails', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const gone = Object.assign(new Error('registration removed'), { status: 410, code: 'a2a_target_gone' });
  await expect(sendToExternalAgent('https://example.com', payload, undefined,
    async () => { throw gone; }, 'a2ae_stable')).rejects.toBe(gone);
  await expect(sendToExternalAgent('http://example.com', payload, undefined,
    async () => ({ scheme: 'bearer', credential: 'rotated-token' }), 'a2ae_stable'))
    .rejects.toMatchObject({ code: 'a2a_agent_url_forbidden' });
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['TimeoutError', 'AbortError', 'TypeError'])('retries %s thrown while reading the response body', async name => {
  vi.useFakeTimers();
  const response = Response.json({});
  const readBody = vi.spyOn(response, 'json').mockRejectedValue(Object.assign(new Error('body interrupted'), { name }));
  const fetch = vi.fn().mockResolvedValueOnce(response).mockResolvedValue(Response.json({ jsonrpc: '2.0', id: 'retry', result: {} }));
  vi.stubGlobal('fetch', fetch);
  const checked = expect(sendToExternalAgent('https://example.com', payload)).resolves.toMatchObject({ response: { id: 'retry' } });
  await vi.runAllTimersAsync(); await checked;
  expect(readBody).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledTimes(2);
});
