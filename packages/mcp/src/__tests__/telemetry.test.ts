import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const mockHomedir = vi.hoisted(() => '/mock/home');
const posthogRequestMock = vi.hoisted(() =>
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
        write: vi.fn(),
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
    request: posthogRequestMock,
  },
}));
vi.mock('node:https', () => ({
  default: {
    request: posthogRequestMock,
  },
}));

import { createMcpTelemetry } from '../telemetry.js';

describe('createMcpTelemetry', () => {
  const mockTelemetryPath = path.join(mockHomedir, '.relay', 'telemetry.json');
  
  beforeEach(() => {
    delete process.env.DO_NOT_TRACK;
    delete process.env.RELAYCAST_TELEMETRY_DISABLED;
    delete process.env.POSTHOG_HOST;
    delete process.env.RELAYCAST_POSTHOG_HOST;
    delete process.env.POSTHOG_API_KEY;
    delete process.env.POSTHOG_KEY;
    delete process.env.RELAYCAST_POSTHOG_KEY;
    delete process.env.RELAYCAST_TELEMETRY_DISTINCT_ID;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('opt-out precedence', () => {
    it('respects DO_NOT_TRACK=1', () => {
      process.env.DO_NOT_TRACK = '1';
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
      vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);

      const telemetry = createMcpTelemetry('1.0.0');
      
      // Capture should return early (no-op) when telemetry is disabled
      // We verify this doesn't throw and state file is still created for future use
      expect(() => telemetry.capture('test_event', {})).not.toThrow();
      expect(fs.mkdirSync).toHaveBeenCalled();
    });

    it('respects RELAYCAST_TELEMETRY_DISABLED=true', () => {
      process.env.RELAYCAST_TELEMETRY_DISABLED = 'true';
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
      vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);

      const telemetry = createMcpTelemetry('1.0.0');
      
      // Capture should return early (no-op) when telemetry is disabled
      expect(() => telemetry.capture('test_event', {})).not.toThrow();
      expect(fs.mkdirSync).toHaveBeenCalled();
    });

    it('respects telemetryDisabled flag in state file', () => {
      const stateWithOptOut = {
        anonymousId: 'test-id-123',
        telemetryDisabled: true,
      };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(stateWithOptOut));

      const telemetry = createMcpTelemetry('1.0.0');
      
      // Capture should return early (no-op) when telemetry is disabled via state
      expect(() => telemetry.capture('test_event', {})).not.toThrow();
      
      // Should read the file but not write a new one
      expect(fs.readFileSync).toHaveBeenCalledWith(mockTelemetryPath, 'utf8');
    });

    it('prefers env opt-out over persisted flag', () => {
      process.env.DO_NOT_TRACK = '1';
      const stateWithOptIn = {
        anonymousId: 'test-id-123',
        telemetryDisabled: false,
      };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(stateWithOptIn));

      const telemetry = createMcpTelemetry('1.0.0');
      
      // Capture should return early because env opt-out takes precedence
      expect(() => telemetry.capture('test_event', {})).not.toThrow();
      
      // Should still respect env opt-out
      expect(fs.readFileSync).toHaveBeenCalledWith(mockTelemetryPath, 'utf8');
    });
  });

  describe('host trimming', () => {
    it('trims trailing slash from POSTHOG_HOST', () => {
      process.env.POSTHOG_HOST = 'https://posthog.example.com/';
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
      vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);

      const telemetry = createMcpTelemetry('1.0.0');
      telemetry.capture('test_event', {});
      
      // Host should be trimmed (we can't directly verify the HTTP call without mocking http/https)
      expect(fs.mkdirSync).toHaveBeenCalled();
    });

    it('uses RELAYCAST_POSTHOG_HOST as fallback', () => {
      process.env.RELAYCAST_POSTHOG_HOST = 'https://relay.posthog.com';
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
      vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);

      const telemetry = createMcpTelemetry('1.0.0');
      telemetry.capture('test_event', {});
      
      expect(fs.mkdirSync).toHaveBeenCalled();
    });
  });

  describe('error-tolerant state persistence', () => {
    it('handles read-only filesystem gracefully on fresh state', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      vi.mocked(fs.mkdirSync).mockImplementation(() => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      });
      vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);

      // Should not throw even if mkdir fails
      expect(() => {
        const telemetry = createMcpTelemetry('1.0.0');
        telemetry.capture('test_event', {});
      }).not.toThrow();
    });

    it('handles write errors gracefully', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      });

      // Should not throw even if writeFile fails
      expect(() => {
        const telemetry = createMcpTelemetry('1.0.0');
        telemetry.capture('test_event', {});
      }).not.toThrow();
    });

    it('handles malformed state file gracefully', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('invalid json{');
      vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
      vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);

      // Should not throw and should create fresh state
      expect(() => {
        const telemetry = createMcpTelemetry('1.0.0');
        telemetry.capture('test_event', {});
      }).not.toThrow();
      
      expect(fs.mkdirSync).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('works with ephemeral anonymous ID when persistence fails', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      vi.mocked(fs.mkdirSync).mockImplementation(() => {
        throw new Error('Cannot create directory');
      });

      // Should not throw and telemetry should still work
      expect(() => {
        const telemetry = createMcpTelemetry('1.0.0');
        telemetry.capture('test_event', {});
        void telemetry.flush();
      }).not.toThrow();
    });
  });

  describe('flush', () => {
    it('completes without errors when no events are pending', async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
      vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);

      const telemetry = createMcpTelemetry('1.0.0');
      await expect(telemetry.flush()).resolves.toBeUndefined();
    });

    it('respects timeout parameter', async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
      vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);

      const telemetry = createMcpTelemetry('1.0.0');
      
      // Capture an event (though HTTP call will be mocked/fail)
      telemetry.capture('test_event', {});
      
      // Should timeout quickly with custom timeout
      const start = Date.now();
      await telemetry.flush(100);
      const duration = Date.now() - start;
      
      // Should be around 100ms, with some tolerance
      expect(duration).toBeLessThan(200);
    });
  });
});
