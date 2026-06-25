import { describe, expect, it, vi } from 'vitest';
import { emitInvocationCompletionEffects, type InvocationCompletionDeps } from '../invocationCompletion.js';

/**
 * The caller of an action receives a targeted completion delivery; it must not
 * also be included in a workspace-wide agent fanout, or an online caller gets
 * the same action.completed/failed event twice. Other agents observe completion
 * only through the workspace observer stream.
 */
describe('emitInvocationCompletionEffects caller dedupe', () => {
  it('delivers the completion to an online caller exactly once', async () => {
    const deliverToAgents = vi.fn(async () => {});
    const publishToWorkspaceStream = vi.fn(async () => {});
    const deps = {
      db: { insert: () => { throw new Error('skip durable outbox in test'); } },
      realtime: {
        deliverToAgents,
        publishToWorkspaceStream,
      },
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

    const deliveredAgentIds = deliverToAgents.mock.calls.flatMap(
      ([args]) => (args as { agentIds: string[] }).agentIds,
    );
    expect(deliveredAgentIds.filter((id) => id === 'caller-1')).toHaveLength(1);
    expect(deliveredAgentIds).not.toContain('other-1');
    expect(publishToWorkspaceStream).toHaveBeenCalledTimes(1);
  });
});
