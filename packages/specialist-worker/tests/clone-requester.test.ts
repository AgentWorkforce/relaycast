import { describe, expect, it, vi } from 'vitest';

import {
  createCloneRequester,
  NoopCloneRequester,
  HttpCloneRequester,
} from '../src/specialist/clone-requester.js';

async function flushBackgroundWork(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function makeResponse(body = '', status = 202): Response {
  return new Response(body, { status });
}

describe('createCloneRequester', () => {
  it('returns a noop when cloudApiUrl or cloudApiToken is empty', () => {
    expect(createCloneRequester({ cloudApiUrl: '', cloudApiToken: 'x' })).toBeInstanceOf(NoopCloneRequester);
    expect(createCloneRequester({ cloudApiUrl: 'https://x', cloudApiToken: '' })).toBeInstanceOf(NoopCloneRequester);
    expect(createCloneRequester({})).toBeInstanceOf(NoopCloneRequester);
  });

  it('returns an HttpCloneRequester when both url and token are configured', () => {
    const req = createCloneRequester({
      cloudApiUrl: 'https://cloud.example',
      cloudApiToken: 'cloud-token',
    });
    expect(req).toBeInstanceOf(HttpCloneRequester);
  });
});

describe('HttpCloneRequester.requestIfNeeded', () => {
  it('POSTs to /api/v1/github/clone/request with auth + JSON body and cancels the response body', async () => {
    const fetchImpl = vi.fn(async () => makeResponse());
    const requester = new HttpCloneRequester({
      cloudApiUrl: 'https://cloud.example/',
      cloudApiToken: 'cloud-token',
      fetchImpl: fetchImpl as typeof globalThis.fetch,
    });

    requester.requestIfNeeded('ws_1', 'octo', 'hello');

    await flushBackgroundWork();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://cloud.example/api/v1/github/clone/request');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer cloud-token',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      workspaceId: 'ws_1',
      owner: 'octo',
      repo: 'hello',
      ref: 'HEAD',
    });
  });

  it('dedups repeated calls within the cooldown window', async () => {
    const fetchImpl = vi.fn(async () => makeResponse());
    let clock = 1_000_000;
    const requester = new HttpCloneRequester({
      cloudApiUrl: 'https://cloud.example',
      cloudApiToken: 'tok',
      cooldownMs: 60_000,
      fetchImpl: fetchImpl as typeof globalThis.fetch,
      now: () => clock,
    });

    requester.requestIfNeeded('ws', 'o', 'r');
    await flushBackgroundWork();
    requester.requestIfNeeded('ws', 'o', 'r');
    clock += 30_000; // inside cooldown
    requester.requestIfNeeded('ws', 'o', 'r');
    clock += 40_000; // past cooldown
    requester.requestIfNeeded('ws', 'o', 'r');

    await flushBackgroundWork();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('consumes the response body so Workers does not retain an in-flight body', async () => {
    const text = vi.fn().mockResolvedValue('{"ok":true}');
    const response = {
      ok: true,
      status: 202,
      text,
    } as unknown as Response;
    const fetchImpl = vi.fn(async () => response);

    const requester = new HttpCloneRequester({
      cloudApiUrl: 'https://cloud.example',
      cloudApiToken: 'tok',
      fetchImpl: fetchImpl as typeof globalThis.fetch,
    });

    requester.requestIfNeeded('ws', 'o', 'r');
    await flushBackgroundWork();
    expect(text).toHaveBeenCalledTimes(1);
  });

  it('logs rejected responses and uses only the short failure cooldown', async () => {
    const warn = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(makeResponse('forbidden', 403))
      .mockResolvedValue(makeResponse('accepted', 202));
    let clock = 1_000_000;
    const requester = new HttpCloneRequester({
      cloudApiUrl: 'https://cloud.example',
      cloudApiToken: 'tok',
      cooldownMs: 60_000,
      failureCooldownMs: 10_000,
      fetchImpl: fetchImpl as typeof globalThis.fetch,
      now: () => clock,
      logger: { warn },
    });

    requester.requestIfNeeded('ws', 'o', 'r');
    await flushBackgroundWork();
    requester.requestIfNeeded('ws', 'o', 'r');
    clock += 10_001;
    requester.requestIfNeeded('ws', 'o', 'r');
    await flushBackgroundWork();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith('[specialist/clone-requester] clone request rejected', {
      workspaceId: 'ws',
      owner: 'o',
      repo: 'r',
      status: 403,
      body: 'forbidden',
    });
  });

  it('logs and swallows fetch rejection (never throws sync or async)', async () => {
    const warn = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new Error('boom');
    });
    const requester = new HttpCloneRequester({
      cloudApiUrl: 'https://cloud.example',
      cloudApiToken: 'tok',
      fetchImpl: fetchImpl as typeof globalThis.fetch,
      logger: { warn },
    });

    expect(() => requester.requestIfNeeded('ws', 'o', 'r')).not.toThrow();
    await flushBackgroundWork();
    expect(warn).toHaveBeenCalled();
  });
});
