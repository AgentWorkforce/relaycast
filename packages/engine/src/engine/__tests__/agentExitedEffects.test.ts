import { describe, expect, it, vi } from 'vitest';
import {
  emitAgentExitedEffects,
  emitNodeStatusEffects,
  type InvocationCompletionDeps,
} from '../invocationCompletion.js';
import { sendNodeDeliveriesToAgents } from '../nodeDeliver.js';

vi.mock('../nodeDeliver.js', () => ({
  sendNodeDeliveriesToAgents: vi.fn(async () => {}),
}));

/**
 * Build a deps stub whose `db` resolves a caller lookup to `callerId` and lets
 * the durable outbox insert succeed/fail on demand. `select().from().where()`
 * returns the invocation caller row; `insert()` throws when `outboxThrows`.
 */
function makeDeps(opts: { callerId?: string | null; outboxThrows?: boolean } = {}) {
  const publishToWorkspaceStream = vi.fn(async () => {});
  const webhookSend = vi.fn(async () => {});
  const db = {
    select: () => ({
      from: () => ({
        where: async () => (opts.callerId === undefined ? [] : [{ callerId: opts.callerId }]),
      }),
    }),
    insert: () => {
      if (opts.outboxThrows) throw new Error('skip durable outbox in test');
      return { values: async () => {} };
    },
  };
  const deps = {
    db,
    realtime: { publishToWorkspaceStream },
    nodeConnections: {},
    webhookQueue: { send: webhookSend },
    config: {},
  } as unknown as InvocationCompletionDeps;
  return { deps, publishToWorkspaceStream, webhookSend };
}

describe('emitAgentExitedEffects', () => {
  it('fans out to all three channels and delivers to the spawn caller exactly once', async () => {
    const sendMock = vi.mocked(sendNodeDeliveriesToAgents);
    sendMock.mockClear();
    const { deps, publishToWorkspaceStream, webhookSend } = makeDeps({ callerId: 'caller-1' });

    await emitAgentExitedEffects(deps, 'ws-1', {
      agentId: 'agent-9',
      agentName: 'worker',
      nodeId: 'node-3',
      invocationId: 'inv-7',
      reason: 'released',
    });

    // (1) caller mailbox
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[1]).toMatchObject({
      agentIds: ['caller-1'],
      event: 'agent.exited',
      eventKey: 'agent-9_inv-7_released',
      data: {
        agent_id: 'agent-9',
        agent_name: 'worker',
        node_id: 'node-3',
        invocation_id: 'inv-7',
        reason: 'released',
      },
    });
    // (2) durable log + stream
    expect(publishToWorkspaceStream).toHaveBeenCalledTimes(1);
    const published = publishToWorkspaceStream.mock.calls[0]?.[0] as { event: Record<string, unknown> };
    expect(published.event).toMatchObject({ type: 'agent.exited', agent_id: 'agent-9', reason: 'released' });
    // (3) webhook outbox
    expect(webhookSend).toHaveBeenCalledTimes(1);
    expect(webhookSend.mock.calls[0]?.[0]).toMatchObject({ type: 'agent.exited', workspaceId: 'ws-1' });
  });

  it('skips the caller mailbox when there is no correlated invocation', async () => {
    const sendMock = vi.mocked(sendNodeDeliveriesToAgents);
    sendMock.mockClear();
    const { deps, publishToWorkspaceStream, webhookSend } = makeDeps();

    await emitAgentExitedEffects(deps, 'ws-1', {
      agentId: 'agent-9',
      agentName: 'worker',
      nodeId: 'node-3',
      invocationId: null,
      reason: 'deregistered',
    });

    expect(sendMock).not.toHaveBeenCalled();
    expect(publishToWorkspaceStream).toHaveBeenCalledTimes(1);
    expect(webhookSend).toHaveBeenCalledTimes(1);
  });

  it('skips the caller mailbox when the invocation has no live caller', async () => {
    const sendMock = vi.mocked(sendNodeDeliveriesToAgents);
    sendMock.mockClear();
    const { deps, publishToWorkspaceStream } = makeDeps({ callerId: null });

    await emitAgentExitedEffects(deps, 'ws-1', {
      agentId: 'agent-9',
      agentName: 'worker',
      nodeId: null,
      invocationId: 'inv-orphan',
      reason: 'missing_from_inventory',
    });

    expect(sendMock).not.toHaveBeenCalled();
    expect(publishToWorkspaceStream).toHaveBeenCalledTimes(1);
  });

  it('still publishes and sends the webhook when the durable outbox insert fails', async () => {
    const sendMock = vi.mocked(sendNodeDeliveriesToAgents);
    sendMock.mockClear();
    const { deps, publishToWorkspaceStream, webhookSend } = makeDeps({ callerId: null, outboxThrows: true });

    await emitAgentExitedEffects(deps, 'ws-1', {
      agentId: 'agent-9',
      agentName: 'worker',
      nodeId: 'node-3',
      invocationId: null,
      reason: 'deregistered',
    });

    expect(publishToWorkspaceStream).toHaveBeenCalledTimes(1);
    // Webhook send still attempted (without an outboxId) despite the insert failure.
    expect(webhookSend).toHaveBeenCalledTimes(1);
    expect(webhookSend.mock.calls[0]?.[0]).not.toHaveProperty('outboxId');
  });
});

describe('emitNodeStatusEffects', () => {
  it('publishes node.status.offline with a reason and enqueues the webhook', async () => {
    const { deps, publishToWorkspaceStream, webhookSend } = makeDeps({ callerId: null, outboxThrows: true });

    await emitNodeStatusEffects(deps, 'ws-1', {
      status: 'offline',
      nodeId: 'node-3',
      nodeName: 'alpha',
      reason: 'liveness_timeout',
    });

    expect(publishToWorkspaceStream).toHaveBeenCalledTimes(1);
    const published = publishToWorkspaceStream.mock.calls[0]?.[0] as { event: Record<string, unknown> };
    expect(published.event).toMatchObject({
      type: 'node.status.offline',
      node_id: 'node-3',
      node_name: 'alpha',
      reason: 'liveness_timeout',
    });
    expect(webhookSend).toHaveBeenCalledTimes(1);
  });

  it('publishes node.status.online without a reason field', async () => {
    const { deps, publishToWorkspaceStream } = makeDeps({ callerId: null, outboxThrows: true });

    await emitNodeStatusEffects(deps, 'ws-1', {
      status: 'online',
      nodeId: 'node-3',
      nodeName: 'alpha',
    });

    const published = publishToWorkspaceStream.mock.calls[0]?.[0] as { event: Record<string, unknown> };
    expect(published.event).toMatchObject({ type: 'node.status.online', node_id: 'node-3', node_name: 'alpha' });
    expect(published.event).not.toHaveProperty('reason');
  });
});
