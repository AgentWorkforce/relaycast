import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { triggers, webhooks } from '../../db/schema.js';
import { createTrigger } from '../../engine/trigger.js';
import {
  createWorkspace,
  FakeSocket,
  makeNodeStack,
  type TestStack,
} from './harness.js';

describe('inbound webhook message triggers', () => {
  let stack: TestStack;

  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  afterEach(() => stack.close());

  async function enrollNode(workspaceKey: string, nodeId: string, name: string) {
    const response = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${workspaceKey}`,
      },
      body: JSON.stringify({
        node_id: nodeId,
        name,
        role: 'broker',
        capabilities: [],
        max_agents: 4,
        tags: ['test'],
        version: 'v0',
      }),
    });
    expect(response.status).toBe(201);
  }

  async function setup(actionName: string) {
    const workspace = await createWorkspace(stack.app, `inbound-trigger-${actionName}`);
    const nodeId = `node_${actionName}`;
    await enrollNode(workspace.workspaceKey, nodeId, 'local-surface');

    const socket = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(workspace.workspaceId, nodeId, socket);
    await handle.handleMessage(JSON.stringify({
      v: 1,
      id: `register-${actionName}`,
      type: 'node.register',
      name: 'local-surface',
      node_id: nodeId,
      provider: { name: 'local', instance_id: `local-${actionName}` },
      capabilities: [{ name: actionName, kind: 'action' }],
      max_agents: 4,
      tags: ['test'],
      version: 'v1',
      resume_cursor: null,
    }));

    const trigger = await createTrigger(stack.runtime.handle.db, workspace.workspaceId, {
      channel: 'general',
      action_name: actionName,
    });
    const createResponse = await stack.app.request('/v1/webhooks', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${workspace.workspaceKey}`,
      },
      body: JSON.stringify({ channel: 'general', name: 'provider-events' }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as {
      data: { webhook_id: string; token: string };
    };

    const [webhook] = await stack.runtime.handle.db
      .select({ createdBy: webhooks.createdBy, channelId: webhooks.channelId })
      .from(webhooks)
      .where(eq(webhooks.id, created.data.webhook_id));
    expect(webhook?.createdBy).toBeTruthy();

    return { socket, trigger, created: created.data, webhook: webhook! };
  }

  async function waitForAction(socket: FakeSocket, actionName: string) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const frame = socket.ofType('action.invoke').find((event) => event.action === actionName);
      if (frame) return frame;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return undefined;
  }

  it('fires a fleet trigger with the message created by the webhook route', async () => {
    const actionName = 'run-event';
    const { socket, trigger, created, webhook } = await setup(actionName);
    const metadata = { provider: 'github', delivery_id: 'delivery-1' };

    const response = await stack.app.request(`/v1/hooks/${created.webhook_id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${created.token}`,
      },
      body: JSON.stringify({
        text: 'pull request opened',
        source: 'github',
        author: 'GitHub',
        payload: metadata,
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as {
      data: {
        message_id: string;
        channel: string;
        text: string;
        created_at: string;
        metadata: Record<string, unknown>;
      };
    };
    expect(body.data).not.toHaveProperty('agent_id');

    const action = await waitForAction(socket, actionName);
    expect(action).toBeDefined();
    expect(action?.action).toBe(actionName);
    expect(action?.input).toEqual({
      trigger_id: trigger.id,
      message: {
        id: body.data.message_id,
        channel_id: webhook.channelId,
        channel_name: body.data.channel,
        agent_id: webhook.createdBy,
        text: body.data.text,
        mentions: [],
        metadata,
        created_at: body.data.created_at,
      },
    });
  });

  it('does not re-fire a trigger for an action-generated webhook message', async () => {
    const actionName = 'run-guarded-event';
    const { socket, trigger, created } = await setup(actionName);

    const response = await stack.app.request(`/v1/hooks/${created.webhook_id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${created.token}`,
      },
      body: JSON.stringify({
        text: 'generated by an action',
        payload: { action_generated: true },
      }),
    });
    expect(response.status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(socket.ofType('action.invoke')).toHaveLength(0);
    const [storedTrigger] = await stack.runtime.handle.db
      .select({ lastTriggeredAt: triggers.lastTriggeredAt })
      .from(triggers)
      .where(eq(triggers.id, trigger.id));
    expect(storedTrigger?.lastTriggeredAt).toBeNull();
  });
});
