import { describe, expect, it, vi } from 'vitest';
import { emitInvocationCompletionEffects, type InvocationCompletionDeps } from '../invocationCompletion.js';
import { sendNodeDeliveriesToAgents } from '../nodeDeliver.js';

vi.mock('../nodeDeliver.js', () => ({
  sendNodeDeliveriesToAgents: vi.fn(async () => {}),
}));

/**
 * The caller of an action receives a targeted completion delivery; it must not
 * also be included in a workspace-wide agent fanout, or an online caller gets
 * the same action.completed/failed event twice. Other agents observe completion
 * only through the workspace observer stream.
 */
describe('emitInvocationCompletionEffects caller dedupe', () => {
  it('delivers the completion to an online caller exactly once', async () => {
    const sendNodeDeliveriesToAgentsMock = vi.mocked(sendNodeDeliveriesToAgents);
    sendNodeDeliveriesToAgentsMock.mockClear();
    const publishToWorkspaceStream = vi.fn(async () => {});
    const deps = {
      db: { insert: () => { throw new Error('skip durable outbox in test'); } },
      realtime: {
        publishToWorkspaceStream,
      },
      nodeConnections: {},
      webhookQueue: { send: vi.fn(async () => {}) },
    } as unknown as InvocationCompletionDeps;

    await emitInvocationCompletionEffects(deps, 'ws-1', {
      invocation_id: 'inv-1',
      action_name: 'echo',
      caller_id: 'caller-1',
      status: 'completed',
      output: { ok: true },
      error: null,
    });

    expect(sendNodeDeliveriesToAgentsMock).toHaveBeenCalledTimes(1);
    expect(sendNodeDeliveriesToAgentsMock.mock.calls[0]?.[1]).toMatchObject({
      agentIds: ['caller-1'],
      event: 'action.completed',
      eventKey: 'inv-1',
      messageId: 'inv-1',
      data: {
        invocation_id: 'inv-1',
        action_name: 'echo',
        status: 'completed',
        output: { ok: true },
        error: null,
      },
    });
    expect(publishToWorkspaceStream).toHaveBeenCalledTimes(1);
  });
});
