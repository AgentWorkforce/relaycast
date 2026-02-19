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

import {
  isExpectedClientNoise,
  loggerMiddleware,
  resetExpectedClientNoiseBucketsForTest,
} from '../logger.js';

function makeApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', loggerMiddleware);

  app.get('/v1/ws', (c) => c.json({ ok: false, error: { code: 'invalid_token', message: 'Invalid token' } }, 401));
  app.post('/mcp', (c) => c.json({ ok: false, error: { code: 'bad_request', message: 'Invalid MCP payload' } }, 406));
  app.get('/v1/channels', (c) => c.json({ ok: false, error: { code: 'invalid_channel', message: 'Bad input' } }, 400));
  app.get('/boom', (c) => c.json({ ok: false, error: { code: 'internal_error', message: 'boom' } }, 500));
  return app;
}

describe('isExpectedClientNoise', () => {
  it('identifies expected noisy client failures', () => {
    expect(isExpectedClientNoise('/v1/ws', 401, 'invalid_token')).toBe(true);
    expect(isExpectedClientNoise('/mcp', 406, 'bad_request')).toBe(true);
  });

  it('does not classify unrelated client failures as expected noise', () => {
    expect(isExpectedClientNoise('/v1/channels', 400, 'invalid_channel')).toBe(false);
    expect(isExpectedClientNoise('/v1/ws', 404, 'not_found')).toBe(false);
  });
});

describe('loggerMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetExpectedClientNoiseBucketsForTest();
  });

  it('suppresses warn logs for expected websocket auth noise', async () => {
    const app = makeApp();

    const res = await app.request('/v1/ws?token=at_live_badtoken', {
      headers: {
        'CF-Connecting-IP': '203.0.113.10',
        'User-Agent': 'relay-sdk-js/1.0.0',
      },
    });

    expect(res.status).toBe(401);
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.flush).toHaveBeenCalledTimes(1);
  });

  it('suppresses warn logs for expected /mcp protocol noise', async () => {
    const app = makeApp();

    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
      },
      body: JSON.stringify({ invalid: true }),
    });

    expect(res.status).toBe(406);
    expect(mockLogger.warn).not.toHaveBeenCalled();
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
