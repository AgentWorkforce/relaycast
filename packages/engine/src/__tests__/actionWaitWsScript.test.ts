import { describe, expect, it } from 'vitest';
import { observerAllowsEvent } from '../engine/observerToken.js';
import {
  ACTION_WAIT_OBSERVER_SCOPES,
  ACTION_WAIT_WS_PATH,
  actionWaitObserverCreateBody,
  actionWaitWsUrl,
} from '../../../../scripts/action-wait-ws.js';

/**
 * Pins the credential `scripts/e2e.ts` and `scripts/e2e-actions.ts` pass to
 * `/v1/ws`. Upgrade status (agent token 401, observer token 101) is covered by
 * `nodeUpgradeAuth.test.ts` and is not repeated here.
 */
describe('e2e action-wait socket credential', () => {
  it('opens /v1/ws with an observer token, not an agent token or node transport', () => {
    const observer = 'ot_live_observer';
    const url = actionWaitWsUrl('http://localhost:8787/', observer);

    expect(ACTION_WAIT_WS_PATH).toBe('/v1/ws');
    expect(url).toBe(`ws://localhost:8787/v1/ws?token=${observer}`);
    expect(url).not.toContain('/v1/node/ws');
    expect(actionWaitWsUrl('https://cast.example', observer)).toBe(
      `wss://cast.example/v1/ws?token=${observer}`,
    );
    expect(actionWaitObserverCreateBody('actions-e2e')).toEqual({
      name: 'actions-e2e',
      scopes: ['stream:read', 'activity:read'],
    });
    expect(ACTION_WAIT_OBSERVER_SCOPES).toContain('stream:read');
  });

  it('refuses agent, node, and workspace credentials on the workspace socket', () => {
    for (const token of ['at_live_agent', 'nt_live_node', 'rk_live_workspace', '']) {
      expect(() => actionWaitWsUrl('http://localhost:8787', token)).toThrow(/observer token/);
    }
  });

  it('includes activity:read so action frames survive the observer stream filter', () => {
    const invoked = { type: 'action.invoked', action_name: 'deploy', handler_agent_id: 'handler' };
    const completed = { type: 'action.completed', action_name: 'deploy', status: 'completed' };
    const streamOnly = { scopes: ['stream:read'], filters: {} };

    expect(observerAllowsEvent(streamOnly, invoked)).toBe(false);
    expect(observerAllowsEvent(streamOnly, completed)).toBe(false);

    const actionWait = { scopes: [...ACTION_WAIT_OBSERVER_SCOPES], filters: {} };
    expect(observerAllowsEvent(actionWait, invoked)).toBe(true);
    expect(observerAllowsEvent(actionWait, completed)).toBe(true);
  });
});
