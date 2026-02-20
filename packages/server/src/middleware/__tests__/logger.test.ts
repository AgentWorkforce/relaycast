import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../../env.js';

const { mockLogger, createRequestLoggerMock } = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    child: vi.fn(),
  };
  logger.child.mockImplementation(() => logger);
  return {
    mockLogger: logger,
    createRequestLoggerMock: vi.fn(() => logger),
  };
});

vi.mock('../../lib/logger.js', () => ({
  createRequestLogger: createRequestLoggerMock,
}));

import { loggerMiddleware } from '../logger.js';

function makeApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', loggerMiddleware);

  app.get('/v1/ws', (c) => c.json({ ok: false, error: { code: 'invalid_token', message: 'Invalid token' } }, 401));
  app.post('/mcp', (c) => c.json({ ok: false, error: { code: 'bad_request', message: 'Invalid MCP payload' } }, 406));
  app.get('/v1/channels', (c) => c.json({ ok: false, error: { code: 'invalid_channel', message: 'Bad input' } }, 400));
  app.get('/boom', (c) => c.json({ ok: false, error: { code: 'internal_error', message: 'boom' } }, 500));
  return app;
}

describe('loggerMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs websocket auth client errors as warn', async () => {
    const app = makeApp();

    const res = await app.request('/v1/ws?token=at_live_badtoken', {
      headers: {
        'CF-Connecting-IP': '203.0.113.10',
        'User-Agent': 'relay-sdk-js/1.0.0',
      },
    });

    expect(res.status).toBe(401);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    const [message, fields] = mockLogger.warn.mock.calls[0];
    expect(message).toBe('Request client error');
    expect(fields).toMatchObject({
      status_code: 401,
      status_class: '4xx',
      route_group: 'ws',
      auth_scheme: 'query_agent_token',
      error_code: 'invalid_token',
      error_reason: 'Invalid token',
      client_name: 'relay-sdk-js',
    });
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.flush).toHaveBeenCalledTimes(1);
  });

  it('logs /mcp client errors as warn', async () => {
    const app = makeApp();

    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
      },
      body: JSON.stringify({ invalid: true }),
    });

    expect(res.status).toBe(406);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    const [message, fields] = mockLogger.warn.mock.calls[0];
    expect(message).toBe('Request client error');
    expect(fields).toMatchObject({
      status_code: 406,
      status_class: '4xx',
      route_group: 'mcp',
      auth_scheme: 'none',
      error_code: 'bad_request',
      error_reason: 'Invalid MCP payload',
      accept: 'application/json',
    });
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.flush).toHaveBeenCalledTimes(1);
  });

  it('keeps warn logs for unexpected client errors with structured metadata', async () => {
    const app = makeApp();

    const res = await app.request('/v1/channels', {
      headers: {
        Authorization: 'Bearer at_live_abcdef123456',
        'CF-Connecting-IP': '198.51.100.15',
        'User-Agent': 'relay-sdk-js/2.0.0',
        Accept: 'application/json',
      },
    });

    expect(res.status).toBe(400);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    const [message, fields] = mockLogger.warn.mock.calls[0];
    expect(message).toBe('Request client error');
    expect(fields).toMatchObject({
      status_code: 400,
      status_class: '4xx',
      route_group: 'api_v1',
      auth_scheme: 'bearer_agent_token',
      error_code: 'invalid_channel',
      error_reason: 'Bad input',
      client_name: 'relay-sdk-js',
      accept: 'application/json',
    });
    expect(fields.actor_fingerprint).toEqual(expect.any(String));
    expect(fields.ip_hash).toEqual(expect.any(String));
    expect(fields.ua_hash).toEqual(expect.any(String));
    expect(mockLogger.flush).toHaveBeenCalledTimes(1);
  });

  it('captures origin metadata from endpoint parameters', async () => {
    const app = makeApp();

    const res = await app.request('/v1/channels?origin_surface=sdk&origin_client=query-client&origin_version=0.1.0', {
      headers: {
        Authorization: 'Bearer at_live_abcdef123456',
        'X-Relaycast-Origin-Client': '@relaycast/mcp',
        'X-Relaycast-Origin-Version': '0.3.1',
      },
    });

    expect(res.status).toBe(400);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    const [, fields] = mockLogger.warn.mock.calls[0];
    expect(fields).toMatchObject({
      origin_surface: 'sdk',
      origin_client: '@relaycast/mcp',
      origin_version: '0.3.1',
    });
  });

  it('logs server failures as error', async () => {
    const app = makeApp();
    const res = await app.request('/boom');

    expect(res.status).toBe(500);
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    const [message, fields] = mockLogger.error.mock.calls[0];
    expect(message).toBe('Request failed');
    expect(fields).toMatchObject({
      status_code: 500,
      status_class: '5xx',
      route_group: 'other',
    });
  });
});
