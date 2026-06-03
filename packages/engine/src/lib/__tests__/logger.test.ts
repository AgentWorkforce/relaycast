import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '../logger.js';

describe('engine logger PostHog export', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('exports logs through the hosted ingestion proxy by default', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const logger = createLogger(
      {
        environment: 'test',
        appSemver: '1.2.3',
        posthogApiKey: 'phc_example',
      },
      { source: 'test' },
    );

    logger.info('hello');
    await logger.flush();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://i.agentrelay.com/i/v1/logs',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer phc_example',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('allows a custom PostHog host override', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const logger = createLogger(
      {
        environment: 'test',
        posthogApiKey: 'phc_example',
        posthogHost: 'https://posthog.example.test/',
      },
      { source: 'test' },
    );

    logger.info('hello');
    await logger.flush();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://posthog.example.test/i/v1/logs',
      expect.any(Object),
    );
  });
});
