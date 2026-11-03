#!/usr/bin/env npx tsx
/**
 * Two-agent message/reply smoke across two gateway replicas, surviving a
 * restart of one of them. The TypeScript SDK is used unchanged.
 *
 *   alice ──/v1/node/ws──▶ gateway 1 ─┐
 *                                     ├─▶ control plane ─▶ Workspace actor
 *   bob   ──/v1/node/ws──▶ gateway 2 ─┘
 *
 * Checks, in order:
 *   1. `POST /v1/workspaces` on gateway 1 answers an `ar_ws_` key.
 *   2. alice (gateway 1) and bob (gateway 2) connect over `/v1/node/ws`.
 *   3. alice → bob DM and bob → alice reply both arrive over the socket.
 *   4. An observer socket (`/v1/ws`, `ar_ob_` token) on gateway 2 sees a
 *      channel message alice posts through gateway 1.
 *   5. A file uploaded through gateway 1's signed URL downloads through
 *      gateway 2 (shared file store).
 *   6. Gateway 1 restarts (`restartGateway1` callback): alice's SDK client
 *      reconnects by itself, bob's socket on gateway 2 never drops, the
 *      observer socket never drops, and a second exchange succeeds.
 *   7. `GET /v1/deliveries?wait=` through gateway 1 returns as soon as a
 *      delivery arrives (and holds for the full wait when none does).
 *
 * Standalone (no restart; the orchestrator `local.ts` supplies it):
 *   RELAYCAST_GATEWAY1_URL=http://127.0.0.1:8787 RELAYCAST_GATEWAY2_URL=http://127.0.0.1:8788 \
 *     npx tsx packages/actors-gateway/e2e/smoke.ts
 */

import WebSocket from 'ws';
import { RelayCast, type AgentClient } from '../../sdk-typescript/src/index.js';

export interface SmokeOptions {
  gateway1: string;
  gateway2: string;
  /** Stops gateway 1, starts it again on the same port and resolves when `/readyz` is 200. Omit to skip the restart checks. */
  restartGateway1?: () => Promise<void>;
  log?: (line: string) => void;
}

export interface SmokeStep {
  name: string;
  ms: number;
  error?: string;
}

export interface SmokeResult {
  steps: SmokeStep[];
  failed: number;
  /** Whether alice's client reconnected on its own after the restart (vs. an explicit reconnect). */
  aliceReconnect?: 'auto' | 'explicit';
}

const EVENT_TIMEOUT_MS = 10_000;
const RECONNECT_TIMEOUT_MS = 30_000;

type AnyEvent = { type: string } & Record<string, unknown>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Resolves with the first socket event (any type) whose JSON contains `marker`. Must be armed before the trigger. */
function expectSocketEvent(client: AgentClient, marker: string, label: string): Promise<AnyEvent> {
  return withTimeout(
    new Promise<AnyEvent>((resolve) => {
      const off = client.on.any((event) => {
        if (JSON.stringify(event).includes(marker)) {
          off();
          resolve(event as unknown as AnyEvent);
        }
      });
    }),
    EVENT_TIMEOUT_MS,
    label,
  );
}

function expectConnected(client: AgentClient, label: string, timeoutMs = EVENT_TIMEOUT_MS): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve) => {
      const off = client.on.connected(() => {
        off();
        resolve();
      });
    }),
    timeoutMs,
    label,
  );
}

/** A raw `/v1/ws` observer socket: frames are collected so a wait can look back. */
function openObserverSocket(baseUrl: string, token: string) {
  const url = `${baseUrl.replace(/^http/, 'ws')}/v1/ws?token=${encodeURIComponent(token)}`;
  const socket = new WebSocket(url);
  const frames: AnyEvent[] = [];
  let drops = 0;
  let closeInfo = '';
  socket.on('message', (data) => {
    try {
      frames.push(JSON.parse(data.toString()) as AnyEvent);
    } catch {
      /* ignore non-JSON frames */
    }
  });
  socket.on('close', (code, reason) => {
    drops += 1;
    closeInfo = `${code} ${reason.toString()}`;
  });
  const ready = withTimeout(
    new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
      socket.once('unexpected-response', (_req, res) => reject(new Error(`observer upgrade refused: HTTP ${res.statusCode}`)));
    }),
    EVENT_TIMEOUT_MS,
    'observer socket open',
  );
  const waitFor = (marker: string, label: string) =>
    withTimeout(
      new Promise<AnyEvent>((resolve) => {
        const check = () => {
          const found = frames.find((frame) => JSON.stringify(frame).includes(marker));
          if (found) {
            clearInterval(timer);
            resolve(found);
          }
        };
        const timer = setInterval(check, 25);
        check();
      }),
      EVENT_TIMEOUT_MS,
      label,
    ).catch((error: Error) => {
      const seen = frames.map((frame) => frame.type);
      throw new Error(`${error.message}; observer frames seen: [${seen.join(', ')}]${drops ? `; socket closed ${closeInfo}` : ''}`);
    });
  return {
    ready,
    waitFor,
    get drops() {
      return drops;
    },
    get closeInfo() {
      return closeInfo;
    },
    close: () => socket.close(1000, 'done'),
  };
}

function swapOrigin(url: string, origin: string): string {
  const target = new URL(url);
  const base = new URL(origin);
  target.protocol = base.protocol;
  target.host = base.host;
  return target.toString();
}

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  return `HTTP ${response.status} ${text.slice(0, 300)}`;
}

export async function runSmoke(options: SmokeOptions): Promise<SmokeResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const result: SmokeResult = { steps: [], failed: 0 };
  const cleanups: Array<() => void> = [];

  async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      const value = await fn();
      const ms = Date.now() - started;
      result.steps.push({ name, ms });
      log(`[ ok ] ${name} (${ms} ms)`);
      return value;
    } catch (error) {
      const ms = Date.now() - started;
      const message = error instanceof Error ? error.message : String(error);
      result.steps.push({ name, ms, error: message });
      result.failed += 1;
      log(`[FAIL] ${name} (${ms} ms): ${message}`);
      throw error;
    }
  }

  const { gateway1, gateway2 } = options;
  const runId = Date.now().toString(36);

  try {
    // 1. Workspace via gateway 1.
    const workspaceKey = await step('create workspace via gateway 1 (POST /v1/workspaces)', async () => {
      const created = await RelayCast.createWorkspace(`smoke-${runId}`, { baseUrl: gateway1 });
      if (!created.apiKey.startsWith('ar_ws_')) throw new Error(`expected an ar_ws_ key, got ${created.apiKey.slice(0, 8)}…`);
      return created.apiKey;
    });
    const relay1 = new RelayCast({ apiKey: workspaceKey, baseUrl: gateway1 });
    const relay2 = new RelayCast({ apiKey: workspaceKey, baseUrl: gateway2 });

    // 2. Agents: alice on gateway 1, bob on gateway 2 (registration itself goes through either).
    const { alice, bob } = await step('register alice (gateway 1) and bob (gateway 2)', async () => {
      const aliceReg = await relay1.agents.register({ name: 'alice', type: 'agent' });
      const bobReg = await relay2.agents.register({ name: 'bob', type: 'agent' });
      if (!aliceReg.token.startsWith('ar_ag_')) throw new Error(`expected an ar_ag_ token, got ${aliceReg.token.slice(0, 8)}…`);
      return { alice: relay1.as(aliceReg.token), bob: relay2.as(bobReg.token) };
    });
    cleanups.push(() => alice.disconnect(), () => bob.disconnect());

    let bobDrops = 0;
    bob.on.disconnected(() => {
      bobDrops += 1;
    });
    let aliceDrops = 0;
    bob.on.error(() => {});
    alice.on.error(() => {});
    alice.on.disconnected(() => {
      aliceDrops += 1;
    });

    await step('connect alice → gateway 1 and bob → gateway 2 over /v1/node/ws', async () => {
      const aliceUp = expectConnected(alice, 'alice connect');
      const bobUp = expectConnected(bob, 'bob connect');
      alice.connect();
      bob.connect();
      await Promise.all([aliceUp, bobUp]);
      // Let the node.register frames land before the first send.
      await sleep(500);
    });

    // 3. First exchange over the sockets.
    async function exchange(tag: string): Promise<void> {
      const toBob = `smoke-${runId}-${tag}-alice-to-bob`;
      const bobGets = expectSocketEvent(bob, toBob, `bob receives "${toBob}" on gateway 2`);
      await alice.dm('bob', toBob);
      const bobEvent = await bobGets;
      const toAlice = `smoke-${runId}-${tag}-bob-to-alice`;
      const aliceGets = expectSocketEvent(alice, toAlice, `alice receives "${toAlice}" on gateway 1`);
      await bob.dm('alice', toAlice);
      const aliceEvent = await aliceGets;
      log(`       bob saw ${bobEvent.type}; alice saw ${aliceEvent.type}`);
    }
    await step('exchange 1: alice → bob DM and bob → alice reply arrive over the sockets', () => exchange('x1'));

    // 4. Observer socket on gateway 2 sees a channel post made through gateway 1.
    const observer = await step('observer token (ar_ob_) via gateway 1, /v1/ws open on gateway 2', async () => {
      // `message.created` needs messages:read, `channel.created` channels:read; stream:read alone connects and drops them.
      const token = await relay1.observerTokens.create({
        name: `smoke-${runId}`,
        scopes: ['stream:read', 'messages:read', 'channels:read', 'activity:read'],
      });
      if (!token.token?.startsWith('ar_ob_')) throw new Error(`expected an ar_ob_ observer token, got ${token.token?.slice(0, 8)}…`);
      const socket = openObserverSocket(gateway2, token.token);
      await socket.ready;
      return socket;
    });
    cleanups.push(() => observer.close());

    const channel = `smoke-${runId}`;
    await step('alice posts in a channel via gateway 1; observer on gateway 2 receives the event', async () => {
      await alice.channels.create({ name: channel });
      const marker = `smoke-${runId}-channel-1`;
      const seen = observer.waitFor(marker, 'observer receives channel message');
      await alice.send(channel, marker);
      const frame = await seen;
      log(`       observer saw ${frame.type}`);
    });

    // 5. Signed file URLs across replicas.
    await step('file: upload via gateway 1 signed URL, complete, download via gateway 2', async () => {
      const body = Buffer.from(`smoke file ${runId}\n`.repeat(8));
      const upload = (await alice.files.upload({
        filename: 'smoke.txt',
        contentType: 'text/plain',
        sizeBytes: body.byteLength,
      })) as unknown as Record<string, unknown>;
      const uploadUrl = String(upload.uploadUrl ?? '');
      const fileId = String(upload.fileId ?? upload.id ?? '');
      if (!uploadUrl || !fileId) throw new Error(`unexpected upload response ${JSON.stringify(upload)}`);
      if (!uploadUrl.startsWith(gateway1)) throw new Error(`signed upload URL is not on gateway 1 (RELAYCAST_PUBLIC_URL): ${uploadUrl}`);
      const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body });
      if (!put.ok) throw new Error(`PUT signed URL failed: ${await readError(put)}`);
      const completed = (await alice.files.complete(fileId)) as unknown as Record<string, unknown>;
      const downloadUrl = String(completed.downloadUrl ?? '');
      if (!downloadUrl) throw new Error(`complete returned no download_url: ${JSON.stringify(completed)}`);
      const viaGateway2 = await fetch(swapOrigin(downloadUrl, gateway2));
      if (!viaGateway2.ok) throw new Error(`GET via gateway 2 failed: ${await readError(viaGateway2)}`);
      const bytes = Buffer.from(await viaGateway2.arrayBuffer());
      if (!bytes.equals(body)) throw new Error(`downloaded ${bytes.byteLength} bytes via gateway 2, expected ${body.byteLength} identical bytes`);
      if (viaGateway2.headers.get('content-type') !== 'text/plain') {
        throw new Error(`content-type via gateway 2 was ${viaGateway2.headers.get('content-type')}`);
      }
      const viaGateway1 = await fetch(downloadUrl);
      if (!viaGateway1.ok) throw new Error(`GET via gateway 1 failed: ${await readError(viaGateway1)}`);
    });

    // 6. Restart gateway 1.
    if (options.restartGateway1) {
      const restart = options.restartGateway1;
      await step('restart gateway 1 (SIGTERM, start again, /readyz) while alice is connected through it', async () => {
        const dropsBefore = aliceDrops;
        const reconnected = expectConnected(alice, 'alice reconnect after gateway 1 restart', RECONNECT_TIMEOUT_MS);
        await restart();
        if (aliceDrops === dropsBefore) {
          // The close may still be in flight; give it a moment before judging.
          await sleep(500);
        }
        if (aliceDrops === dropsBefore) throw new Error("alice's socket did not close when gateway 1 stopped");
        try {
          await reconnected;
          result.aliceReconnect = 'auto';
          log('       alice reconnected by itself (SDK WsClient auto-reconnect)');
        } catch (error) {
          log(`       ${error instanceof Error ? error.message : String(error)}; reconnecting alice explicitly`);
          alice.disconnect();
          const again = expectConnected(alice, 'alice explicit reconnect');
          alice.connect();
          await again;
          result.aliceReconnect = 'explicit';
        }
        await sleep(500);
      });

      await step("bob's socket on gateway 2 and the observer socket never dropped", async () => {
        if (bobDrops !== 0) throw new Error(`bob's socket closed ${bobDrops} time(s)`);
        if (observer.drops !== 0) throw new Error(`observer socket closed: ${observer.closeInfo}`);
      });

      await step('exchange 2 after the restart: alice → bob and bob → alice', () => exchange('x2'));

      await step('observer on gateway 2 still receives a post made through the restarted gateway 1', async () => {
        const marker = `smoke-${runId}-channel-2`;
        const seen = observer.waitFor(marker, 'observer receives second channel message');
        await alice.send(channel, marker);
        await seen;
      });
    } else {
      log('[skip] gateway 1 restart (no restartGateway1 callback; run via local.ts for the restart checks)');
    }

    // 7. Deliveries long-poll through gateway 1.
    await step('GET /v1/deliveries?wait= via gateway 1: holds when empty, returns promptly on a delivery', async () => {
      const carol = await relay1.agents.register({ name: 'carol', type: 'agent' });
      const poll = async (waitMs: number) => {
        const started = Date.now();
        const response = await fetch(`${gateway1}/v1/deliveries?wait=${waitMs}`, {
          headers: { authorization: `Bearer ${carol.token}` },
        });
        if (!response.ok) throw new Error(`deliveries poll failed: ${await readError(response)}`);
        const json = (await response.json()) as { ok: boolean; data: unknown[] };
        return { ms: Date.now() - started, count: Array.isArray(json.data) ? json.data.length : -1 };
      };
      const empty = await poll(1000);
      if (empty.count !== 0) throw new Error(`expected no deliveries, got ${empty.count}`);
      if (empty.ms < 900 || empty.ms > 2500) throw new Error(`empty wait=1000 returned after ${empty.ms} ms`);
      const pending = poll(3000);
      await sleep(300);
      await alice.dm('carol', `smoke-${runId}-poll`);
      const hit = await pending;
      if (hit.count < 1) throw new Error(`expected a delivery, got ${hit.count}`);
      if (hit.ms > 2500) throw new Error(`wait=3000 returned only after ${hit.ms} ms`);
      log(`       empty wait=1000 held ${empty.ms} ms; wait=3000 returned ${hit.count} delivery after ${hit.ms} ms`);
    });
  } catch {
    // The failing step has been recorded; later steps depend on it.
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup();
      } catch {
        /* best effort */
      }
    }
  }
  return result;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const gateway1 = (process.env.RELAYCAST_GATEWAY1_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
  const gateway2 = (process.env.RELAYCAST_GATEWAY2_URL ?? 'http://127.0.0.1:8788').replace(/\/+$/, '');
  runSmoke({ gateway1, gateway2 }).then((result) => {
    console.log(`${result.steps.length - result.failed}/${result.steps.length} steps passed`);
    process.exit(result.failed === 0 ? 0 : 1);
  });
}
