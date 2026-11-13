import { afterEach, describe, expect, it } from 'vitest';
import type { Context } from 'hono';
import type { AppEnv } from '../../env.js';
import { backgroundTasksInFlight, runInBackground } from '../../routes/background.js';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';

/**
 * While the process has more accepted background work in flight than
 * `maxBackgroundTasks`, writes are refused with 503 `server_overloaded` and
 * `Retry-After` (nothing is written); reads still work, and writes resume once
 * the backlog drains (relaycast#659).
 */
describe('overload shedding', () => {
  let stack: TestStack | undefined;
  afterEach(() => stack?.close());

  it('sheds writes with 503 + Retry-After while background work is over the bound', async () => {
    stack = makeNodeStack({ maxBackgroundTasks: 3 });
    const ws = await createWorkspace(stack.app, 'overload');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    await stack.settle();
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` };
    const post = (text: string) => stack!.app.request('/v1/channels/general/messages', {
      method: 'POST', headers, body: JSON.stringify({ text }),
    });

    // Pin background work in flight up to the bound.
    const releases: Array<() => void> = [];
    const base = backgroundTasksInFlight();
    for (let i = base; i < 3; i += 1) {
      runInBackground({} as Context<AppEnv>, new Promise<void>((resolve) => { releases.push(resolve); }), 'test hold');
    }
    expect(backgroundTasksInFlight()).toBeGreaterThanOrEqual(3);

    const shed = await post('shed me');
    expect(shed.status).toBe(503);
    expect(shed.headers.get('retry-after')).toBe('1');
    expect(((await shed.json()) as { error: { code: string } }).error.code).toBe('server_overloaded');
    const read = await stack.app.request('/v1/channels/general/messages', { headers });
    expect(read.status).toBe(200);
    const listed = ((await read.json()) as { data: Array<{ text: string }> }).data;
    expect(listed.map((m) => m.text)).not.toContain('shed me');

    for (const release of releases) release();
    await stack.settle();
    expect((await post('after drain')).status).toBe(201);
    const after = await stack.app.request('/v1/channels/general/messages', { headers });
    const texts = ((await after.json()) as { data: Array<{ text: string }> }).data.map((m) => m.text);
    expect(texts).toContain('after drain');
    expect(texts).not.toContain('shed me');
  });
});
