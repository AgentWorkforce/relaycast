import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const mockHomedir = vi.hoisted(() => '/mock/home');
const capturedBodies = vi.hoisted(() => [] as string[]);
const nodeRequestMock = vi.hoisted(() =>
  vi.fn(
    (
      _options: unknown,
      callback?: (res: { resume: () => void; on: (event: string, listener: () => void) => void }) => void,
    ) => {
      const endListeners: Array<() => void> = [];
      callback?.({
        resume: () => undefined,
        on: (event: string, listener: () => void) => {
          if (event === 'end') {
            endListeners.push(listener);
          }
        },
      });

      return {
        on: vi.fn(),
        setTimeout: vi.fn(),
        destroy: vi.fn(),
        write: vi.fn((chunk: unknown) => {
          capturedBodies.push(String(chunk));
        }),
        end: vi.fn(() => {
          for (const listener of endListeners) {
            listener();
          }
        }),
      };
    },
  ),
);

vi.mock('node:os', () => ({
  default: {
    homedir: () => mockHomedir,
  },
}));

vi.mock('node:fs');
vi.mock('node:http', () => ({
  default: {
    request: nodeRequestMock,
  },
}));
vi.mock('node:https', () => ({
  default: {
    request: nodeRequestMock,
  },
}));

import { createMcpTelemetry } from '../telemetry.js';

describe('createMcpTelemetry', () => {
  const mockTelemetryPath = path.join(mockHomedir, '.relay', 'telemetry.json');

  beforeEach(() => {
    delete process.env.DO_NOT_TRACK;
    delete process.env.RELAYCAST_TELEMETRY_DISABLED;
    delete process.env.RELAYCAST_POSTHOG_HOST;
    delete process.env.POSTHOG_HOST;
    delete process.env.RELAYCAST_POSTHOG_API_KEY;
    delete process.env.POSTHOG_API_KEY;
    delete process.env.RELAYCAST_TELEMETRY_DISTINCT_ID;
  });

  afterEach(() => {
    vi.clearAllMocks();
    capturedBodies.length = 0;
  });

  it('respects opt-out environment variables', async () => {
    process.env.DO_NOT_TRACK = '1';
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
    vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);

    const telemetry = createMcpTelemetry('1.0.0');
    telemetry.capture('relaycast_mcp_server_started', {});
    await telemetry.flush();

    expect(nodeRequestMock).not.toHaveBeenCalled();
    expect(fs.readFileSync).toHaveBeenCalledWith(mockTelemetryPath, 'utf8');
  });

  it('posts telemetry to the hosted capture proxy by default', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ anonymousId: 'anon-123' }));

    const telemetry = createMcpTelemetry('1.0.0', {
      posthogApiKey: 'phc_example',
      originSurface: 'mcp',
      originClient: '@relaycast/mcp',
      originVersion: '1.0.0',
    });

    telemetry.capture('relaycast_mcp_server_started', { transport: 'stdio' });
    await telemetry.flush();

    expect(nodeRequestMock).toHaveBeenCalledTimes(1);
    const options = nodeRequestMock.mock.calls[0]?.[0] as {
      hostname: string;
      path: string;
      headers: Record<string, string>;
    };
    expect(options.hostname).toBe('i.agentrelay.com');
    expect(options.path).toBe('/capture/');

    const body = JSON.parse(capturedBodies[0] ?? '{}') as {
      api_key: string;
      properties: Record<string, unknown>;
    };
    expect(body.api_key).toBe('phc_example');
    expect(body.properties.origin_surface).toBe('mcp');
    expect(body.properties.origin_client).toBe('@relaycast/mcp');
    expect(body.properties.origin_version).toBe('1.0.0');
  });

  it('allows a custom PostHog host override', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ anonymousId: 'anon-123' }));

    const telemetry = createMcpTelemetry('1.0.0', {
      posthogHost: 'https://app.posthog.example/',
      posthogApiKey: 'phc_example',
    });

    telemetry.capture('relaycast_mcp_server_started', { transport: 'stdio' });
    await telemetry.flush();

    const options = nodeRequestMock.mock.calls[0]?.[0] as {
      hostname: string;
      path: string;
    };
    expect(options.hostname).toBe('app.posthog.example');
    expect(options.path).toBe('/capture/');
  });

  it('prefers fetch transport when worker globals are present', async () => {
    const originalFetch = globalThis.fetch;
    const originalWebSocketPair = (globalThis as { WebSocketPair?: unknown }).WebSocketPair;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });

    try {
      (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
      (globalThis as { WebSocketPair?: unknown }).WebSocketPair = class {};

      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
      vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);

      const telemetry = createMcpTelemetry('1.0.0', {
        posthogHost: 'https://api.example.com',
        posthogApiKey: 'phc_example',
      });
      telemetry.capture('relaycast_mcp_server_started', {});
      await telemetry.flush();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(nodeRequestMock).not.toHaveBeenCalled();
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      if (typeof originalWebSocketPair === 'undefined') {
        delete (globalThis as { WebSocketPair?: unknown }).WebSocketPair;
      } else {
        (globalThis as { WebSocketPair?: unknown }).WebSocketPair = originalWebSocketPair;
      }
    }
  });

  it('silently no-ops when no PostHog API key is configured', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ anonymousId: 'anon-123' }));

    // No env key, no option key → telemetry disabled, no HTTP call.
    const telemetry = createMcpTelemetry('1.0.0', { posthogHost: 'https://api.example.com' });
    telemetry.capture('relaycast_mcp_server_started', { transport: 'stdio' });
    await telemetry.flush();

    expect(nodeRequestMock).not.toHaveBeenCalled();
    expect(capturedBodies).toHaveLength(0);
  });

  it('flush resolves when no events are pending', async () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
    vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);

    const telemetry = createMcpTelemetry('1.0.0');
    await expect(telemetry.flush()).resolves.toBeUndefined();
  });
});
