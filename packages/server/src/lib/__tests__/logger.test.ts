import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../logger.js';

function getAttribute(
  attrs: Array<{ key: string; value: Record<string, unknown> }>,
  key: string,
): Record<string, unknown> | undefined {
  return attrs.find((attr) => attr.key === key)?.value;
}

describe('logger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes structured console logs outside production', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const logger = createLogger({
      ENVIRONMENT: 'development',
      APP_SEMVER: '1.2.3',
      SDK_SEMVER: '9.9.9',
    } as any, {
      source: 'test.logger',
    });

    logger.error('boom', { workspace_id: 'ws_123' });

    expect(consoleError).toHaveBeenCalledWith(
      '[test.logger] boom',
      expect.objectContaining({
        app_version: '1.2.3',
        sdk_version: '9.9.9',
        workspace_id: 'ws_123',
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends logs to PostHog in production with version metadata', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const logger = createLogger({
      ENVIRONMENT: 'production',
      APP_SEMVER: '2.0.0',
      POSTHOG_API_KEY: 'phc_test_project_key',
      POSTHOG_HOST: 'https://us.i.posthog.com/',
    } as any, {
      source: 'worker.on_error',
      sdkVersion: '0.3.1',
    });

    logger.error('Unhandled request error', { workspace_id: 'ws_123', status: 500 });
    await Promise.resolve();

    expect(consoleError).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://us.i.posthog.com/i/v1/logs');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer phc_test_project_key');

    const payload = JSON.parse(String(init.body));
    const logRecord = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
    const attrs = logRecord.attributes as Array<{ key: string; value: Record<string, unknown> }>;

    expect(getAttribute(attrs, 'app_version')?.stringValue).toBe('2.0.0');
    expect(getAttribute(attrs, 'sdk_version')?.stringValue).toBe('0.3.1');
    expect(getAttribute(attrs, 'workspace_id')?.stringValue).toBe('ws_123');
    expect(getAttribute(attrs, 'status')?.intValue).toBe('500');
  });

  it('prefers x-sdk-version request header over env sdk version', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const logger = createLogger({
      ENVIRONMENT: 'production',
      APP_SEMVER: '2.0.0',
      SDK_SEMVER: 'env-sdk-version',
      POSTHOG_API_KEY: 'phc_test_project_key',
    } as any, {
      source: 'request.test',
      request: new Request('https://api.relaycast.dev/v1/workspace', {
        headers: { 'x-sdk-version': 'header-sdk-version' },
      }),
    });

    logger.warn('Request warning');
    await Promise.resolve();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body));
    const attrs = payload.resourceLogs[0].scopeLogs[0].logRecords[0]
      .attributes as Array<{ key: string; value: Record<string, unknown> }>;

    expect(getAttribute(attrs, 'sdk_version')?.stringValue).toBe('header-sdk-version');
  });
});
