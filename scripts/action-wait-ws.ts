/**
 * Credential for the workspace sockets in the action E2E scripts.
 *
 * `/v1/ws` is the workspace observer stream. Agent tokens are rejected there
 * (401); an observer token with `stream:read` upgrades (101). Agent tokens stay
 * on the HTTP action calls. These waits do not use node transport.
 *
 * `action.invoked` and `action.completed` are published on that stream, and the
 * stream filter treats `action.*` as activity. `stream:read` alone connects and
 * then drops those frames, so the token also carries `activity:read`.
 */

export const ACTION_WAIT_WS_PATH = '/v1/ws';

export const ACTION_WAIT_OBSERVER_SCOPES = ['stream:read', 'activity:read'] as const;

export type ActionWaitObserverScope = (typeof ACTION_WAIT_OBSERVER_SCOPES)[number];

const OBSERVER_TOKEN_PREFIX = 'ot_live_';

export function actionWaitObserverCreateBody(name: string): {
  name: string;
  scopes: ActionWaitObserverScope[];
} {
  return { name, scopes: [...ACTION_WAIT_OBSERVER_SCOPES] };
}

/** URL for one `/v1/ws` action-wait socket. Rejects anything that is not an observer token. */
export function actionWaitWsUrl(httpBase: string, observerToken: string): string {
  if (!observerToken.startsWith(OBSERVER_TOKEN_PREFIX)) {
    throw new Error('action waits require an observer token (ot_live_) with stream:read');
  }
  const wsBase = httpBase.replace(/\/+$/, '').replace(/^http/, 'ws');
  return `${wsBase}${ACTION_WAIT_WS_PATH}?token=${encodeURIComponent(observerToken)}`;
}
