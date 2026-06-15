import { describe, expect, it, vi } from 'vitest';
import { emitInvocationCompletionEffects, type InvocationCompletionDeps } from '../invocationCompletion.js';

/**
 * The caller of an action receives a targeted completion delivery; it must not
 * also be included in the workspace-wide online fanout, or an online caller gets
 * the same action.completed/failed event twice.
 */
describe('emitInvocationCompletionEffects caller dedupe', () => {
  it('delivers the completion to an online caller exactly once', async () => {
    const deliverToAgents = vi.fn(async () => {});
    const deps = {
      db: { insert: () => { throw new Error('skip durable outbox in test'); } },
      realtime: {
        deliverToAgents,
        publishToWorkspaceStream: vi.fn(async () => {}),
      },
      webhookQueue: { send: vi.fn(async () => {}) },
      kv: { get: async () => null },
      config: { workspaceStreamEnabled: false },
      presence: { getOnline: async () => ['caller-1', 'other-1'] },
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
    // The other online agent still receives the broadcast.
    expect(deliveredAgentIds).toContain('other-1');
  });
});
