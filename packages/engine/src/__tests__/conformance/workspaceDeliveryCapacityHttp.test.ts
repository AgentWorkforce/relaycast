import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';
import { deliveries, messages } from '../../db/tables.js';

/**
 * The workspace growth guard refuses a fanout by writing NULL into
 * `deliveries.status`, so D1 records the refusal as
 * `NOT NULL constraint failed: deliveries.status`. Clients see a retryable 429.
 */
describe('workspace delivery capacity over HTTP', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack({ workspaceDelivery: { cap: 1 } }); });
  afterEach(() => stack.close());

  it('answers a full workspace backlog with 429 and Retry-After, storing nothing', async () => {
    const ws = await createWorkspace(stack.app, 'capacity-http');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const post = (text: string) => stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text }),
    });

    expect((await post('fills the backlog')).status).toBe(201);
    const refused = await post('over the cap');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('Retry-After')).toBe('30');
    expect(await refused.json()).toMatchObject({ error: { code: 'workspace_delivery_depth_exceeded' } });

    const db = stack.runtime.handle.db;
    expect(await db.select().from(deliveries).where(eq(deliveries.workspaceId, ws.workspaceId))).toHaveLength(1);
    expect((await db.select().from(messages).where(eq(messages.workspaceId, ws.workspaceId))).map(m => m.body))
      .toEqual(['fills the backlog']);
  });
});
