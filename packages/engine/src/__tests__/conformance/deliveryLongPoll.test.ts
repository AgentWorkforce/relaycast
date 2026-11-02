import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeNodeStack, createWorkspace, registerAgent, type TestStack } from './harness.js';

/**
 * `GET /v1/deliveries?wait=`: an empty answer parks until a delivery is
 * created for the agent, and a parked request issues no statements.
 */
describe('delivery long-poll', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  afterEach(async () => { await stack.close(); });

  async function seed() {
    const ws = await createWorkspace(stack.app, 'long-poll-ws');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    return { ws, alice, bob };
  }

  function poll(token: string, query: string, init: RequestInit = {}) {
    return stack.app.request(`/v1/deliveries${query}`, { ...init, headers: { authorization: `Bearer ${token}` } });
  }

  async function items(response: Response) {
    expect(response.status).toBe(200);
    return ((await response.json()) as { data: Array<{ id: string; message: { text: string } | null }> }).data;
  }

  async function dm(from: string, to: string, text: string) {
    const res = await stack.app.request('/v1/dm', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${from}` },
      body: JSON.stringify({ to, text }),
    });
    expect(res.status).toBeLessThan(300);
  }

  function countStatements() {
    const statements: string[] = [];
    const sqlite = stack.runtime.handle.sqlite;
    const prepare = sqlite.prepare.bind(sqlite);
    sqlite.prepare = ((sql: string) => {
      statements.push(sql);
      return prepare(sql);
    }) as typeof sqlite.prepare;
    return { take: () => statements.splice(0) };
  }

  it('answers at once when deliveries are pending', async () => {
    const { alice, bob } = await seed();
    await dm(alice.token, 'bob', 'already here');
    await stack.settle();

    const started = Date.now();
    const pending = await items(await poll(bob.token, '?wait=25000'));
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(pending.map((item) => item.message?.text)).toEqual(['already here']);
  });

  it('parks an empty answer until a delivery is created for the agent', async () => {
    const { alice, bob } = await seed();
    let answered = false;
    const parked = poll(bob.token, '?wait=2000').then((response) => {
      answered = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(answered).toBe(false);

    await dm(alice.token, 'bob', 'wake up');
    const woken = await items(await parked);
    expect(woken.map((item) => item.message?.text)).toEqual(['wake up']);
    await stack.settle();
  });

  it('is not woken by a delivery for another agent', async () => {
    const { alice, bob } = await seed();
    const started = Date.now();
    const parked = poll(bob.token, '?wait=300');
    await dm(bob.token, 'alice', 'for alice');
    expect(await items(await parked)).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    await stack.settle();
    expect(await items(await poll(alice.token, ''))).toHaveLength(1);
  });

  it('issues the same statements as an immediate poll when the wait expires', async () => {
    const { bob } = await seed();
    await items(await poll(bob.token, ''));
    const counter = countStatements();

    await items(await poll(bob.token, ''));
    const immediate = counter.take();
    expect(await items(await poll(bob.token, '?wait=200'))).toEqual([]);
    const parked = counter.take();

    expect(immediate.length).toBeGreaterThan(0);
    expect(parked).toEqual(immediate);
  });

  it('answers empty when the client goes away', async () => {
    const { bob } = await seed();
    const controller = new AbortController();
    const started = Date.now();
    const parked = poll(bob.token, '?wait=25000', { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    expect(await items(await parked)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('rejects a wait outside 0 to 25000 ms', async () => {
    const { bob } = await seed();
    expect((await poll(bob.token, '?wait=25001')).status).toBe(400);
    expect((await poll(bob.token, '?wait=-1')).status).toBe(400);
    expect(await items(await poll(bob.token, '?wait=0'))).toEqual([]);
  });
});
