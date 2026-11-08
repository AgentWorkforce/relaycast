import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startServer, type RunningServer } from '../../../entrypoints/node.js';
import { COLLECTOR_TELEMETRY_DEFAULTS } from '../../../providers/collector-telemetry.js';

/**
 * Node wiring for the self-host analytics producer: `startServer` with
 * `telemetryCollector` exports through a real HTTP collector, and `stop()`
 * drains it within the shutdown timeout.
 */

interface Received {
  method?: string;
  url?: string;
  authorization?: string;
  body: string;
}

async function startCollector(): Promise<{ server: Server; url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') });
      res.statusCode = 204;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/v1/events`, received };
}

async function createWorkspace(running: RunningServer): Promise<string> {
  const { port } = running.server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/v1/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'ws-telemetry-collector' }),
  });
  expect(res.status).toBe(201);
  const body = await res.json() as { data: { api_key: string } };
  return body.data.api_key;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  vi.restoreAllMocks();
});

describe('startServer telemetryCollector', () => {
  it('exports an observation to the collector and drains it on stop()', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const collector = await startCollector();
    cleanups.push(() => new Promise<void>((resolve) => collector.server.close(() => resolve())));
    const running = startServer({
      dbPath: ':memory:',
      port: 0,
      migrate: true,
      config: { environment: 'test' },
      telemetryCollector: { url: collector.url, bearerToken: 'tok_COLLECTOR_SECRET', deployment: 'it-deploy', instance: 'it-0' },
    });
    const apiKey = await createWorkspace(running);

    const started = Date.now();
    await running.stop();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(COLLECTOR_TELEMETRY_DEFAULTS.shutdownTimeoutMs);
    // Sooner than the flush interval: stop() drained the queue rather than the timer sending it.
    expect(elapsed).toBeLessThan(COLLECTOR_TELEMETRY_DEFAULTS.flushIntervalMs);

    expect(collector.received.length).toBeGreaterThanOrEqual(1);
    for (const request of collector.received) {
      expect(request).toMatchObject({ method: 'POST', url: '/v1/events', authorization: 'Bearer tok_COLLECTOR_SECRET' });
      // The producer credential travels only in the header, never in the body.
      expect(request.body).not.toContain('tok_COLLECTOR_SECRET');
      expect(request.body).not.toContain(apiKey);
      expect(request.body).not.toMatch(/credentialHash|credential_hash|api_key|token/i);
    }
    const batches = collector.received.map((request) => JSON.parse(request.body) as {
      schema: string;
      events: Array<Record<string, unknown>>;
    });
    for (const batch of batches) expect(batch.schema).toBe('agent-relay.analytics.batch/v1');
    const created = batches.flatMap((batch) => batch.events).find((event) => event.event === 'workspace.created');
    expect(created).toBeDefined();
    expect(created).toMatchObject({ version: 1, component: 'relaycast', deployment_id: 'it-deploy', properties: { instance: 'it-0' } });
    expect(typeof created!.event_id).toBe('string');
    expect(typeof created!.workspace_id).toBe('string');
    expect(created).not.toHaveProperty('tenant_id');
  });

  it('makes no collector request and closes immediately without telemetryCollector', async () => {
    const collector = await startCollector();
    cleanups.push(() => new Promise<void>((resolve) => collector.server.close(() => resolve())));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const running = startServer({ dbPath: ':memory:', port: 0, migrate: true, config: { environment: 'test' } });
    const { port } = running.server.address() as AddressInfo;
    await createWorkspace(running);

    const started = Date.now();
    await running.stop();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(collector.received).toEqual([]);
    // The only outbound fetches are the test's own calls to the engine.
    const others = fetchSpy.mock.calls.filter(([input]) => !String(input instanceof Request ? input.url : input).startsWith(`http://127.0.0.1:${port}/`));
    expect(others).toEqual([]);
  });
});
