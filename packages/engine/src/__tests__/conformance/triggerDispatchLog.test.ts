import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeNodeStack, createWorkspace, type TestStack } from './harness.js';
import { createTrigger, fireMessageTriggers, type TriggerMessageInput } from '../../engine/trigger.js';

// A trigger whose action can't be dispatched (missing action, no handler,
// offline node) must not fail silently — the message already posted, so a dead
// trigger would otherwise be invisible.
describe('message trigger dispatch failures are logged', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  afterEach(() => stack.close());

  function message(): TriggerMessageInput {
    return {
      id: 'msg_1',
      channel_id: 'chan_general',
      channel_name: 'general',
      agent_id: 'agent_caller',
      agent_name: 'caller',
      text: 'go',
      created_at: new Date().toISOString(),
    };
  }

  it('logs when a trigger action cannot be dispatched instead of swallowing it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ws = await createWorkspace(stack.app, 'trg-log');
      await createTrigger(stack.runtime.handle.db, ws.workspaceId, { channel: 'general', action_name: 'no-such-action' });

      const invoked = await fireMessageTriggers({
        db: stack.runtime.handle.db,
        nodeConnections: stack.runtime.realtime,
        workspaceId: ws.workspaceId,
        message: message(),
      });

      // Dispatch failed, so nothing is reported invoked — but it is logged.
      expect(invoked).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith('[trigger] action dispatch failed', expect.objectContaining({
        actionName: 'no-such-action',
        code: 'action_not_found',
        workspaceId: ws.workspaceId,
      }));
    } finally {
      warn.mockRestore();
    }
  });
});
