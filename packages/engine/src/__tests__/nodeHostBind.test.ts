import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { startServer, type RunningServer } from '../entrypoints/node.js';

/**
 * `StartServerOptions.hostname` (the CLI's `--host` / `RELAYCAST_HOST`) binds
 * one interface; leaving it unset keeps listening on every interface.
 */
describe('node server bind address', () => {
  let running: RunningServer | null = null;

  afterEach(() => {
    running?.stop();
    running = null;
  });

  const listening = async (server: RunningServer['server']): Promise<AddressInfo> => {
    if (!server.listening) await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    return server.address() as AddressInfo;
  };

  it('binds only the given hostname', async () => {
    running = startServer({ dbPath: ':memory:', port: 0, hostname: '127.0.0.1', migrate: true, config: { environment: 'test' } });
    const addr = await listening(running.server);
    expect(addr.address).toBe('127.0.0.1');
    const res = await fetch(`http://127.0.0.1:${addr.port}/health`);
    expect(res.status).toBe(200);
  });

  it('listens on every interface without a hostname', async () => {
    running = startServer({ dbPath: ':memory:', port: 0, migrate: true, config: { environment: 'test' } });
    const addr = await listening(running.server);
    expect(['::', '0.0.0.0']).toContain(addr.address);
  });
});
