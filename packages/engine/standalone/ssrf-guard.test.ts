/**
 * Under Bun, `undici` is Bun's shim and ignores `dispatcher`, so the engine's
 * connect-time DNS pinning must come from the node:https transport instead.
 * Run with `bun test standalone`.
 */
import { afterAll, expect, it, mock } from 'bun:test';
import * as dns from 'node:dns';
import { createServer } from 'node:net';

// Every name resolves to loopback, as a hostile public DNS record would.
mock.module('node:dns', () => ({
  ...dns,
  lookup: (_host: string, _opts: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) =>
    cb(null, [{ address: '127.0.0.1', family: 4 }]),
}));
const { nodeSafeWebhookFetch } = await import('../src/adapters/node/ssrf-fetch.js');

let connections = 0;
const server = createServer((socket) => {
  connections += 1;
  socket.destroy();
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
const { port } = server.address() as { port: number };
afterAll(() => server.close());

it('refuses a webhook host that resolves to a private address before connecting', async () => {
  await expect(
    nodeSafeWebhookFetch(`https://hooks.example.com:${port}/deliver`, { method: 'POST', body: '{}' }),
  ).rejects.toThrow('non-global address');
  expect(connections).toBe(0);
});
