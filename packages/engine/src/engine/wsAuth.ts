import type { AuthProvider, Workspace, ObserverToken } from '../ports/auth.js';
import type { EngineDb } from '../ports/database.js';
import { getAuthTokenKind } from '../auth/tokenKind.js';
import { getNodeByTokenHash } from './node.js';
import { hasObserverScope } from './observerToken.js';

type WsAuthErrorCode = 'unauthorized' | 'invalid_token';

export interface WsAuthError {
  ok: false;
  status: 401;
  code: WsAuthErrorCode;
  message: string;
  upgradeMessage: 'Unauthorized';
}

export type RealtimeWsAuthResult =
  | { ok: true; scope: 'workspace'; workspace: Workspace; observerToken?: ObserverToken }
  | WsAuthError;

export type NodeWsAuthResult =
  | {
      ok: true;
      node: NonNullable<Awaited<ReturnType<typeof getNodeByTokenHash>>>;
    }
  | WsAuthError;

interface WsAuthDeps {
  auth: AuthProvider;
  db: EngineDb;
}

export function extractBearerToken(authHeader: string | undefined): string | undefined {
  return authHeader && /^bearer\s+/i.test(authHeader)
    ? authHeader.replace(/^bearer\s+/i, '').trim()
    : undefined;
}

export function queryOrBearerToken(queryToken: string | null | undefined, authHeader: string | undefined): string | undefined {
  const tokenFromQuery = queryToken?.trim();
  return tokenFromQuery || extractBearerToken(authHeader);
}

export function missingWsToken(): WsAuthError {
  return {
    ok: false,
    status: 401,
    code: 'unauthorized',
    message: 'Missing token',
    upgradeMessage: 'Unauthorized',
  };
}

function invalidWsToken(message: string): WsAuthError {
  return {
    ok: false,
    status: 401,
    code: 'invalid_token',
    message,
    upgradeMessage: 'Unauthorized',
  };
}

export async function authenticateRealtimeWs(deps: WsAuthDeps, token: string): Promise<RealtimeWsAuthResult> {
  const tokenKind = getAuthTokenKind(token);

  if (tokenKind === 'agent') {
    return invalidWsToken('Agent realtime WebSockets have moved to node transport');
  }

  if (tokenKind === 'workspace') {
    return invalidWsToken('Observer token required for workspace stream');
  }

  if (tokenKind === 'node') {
    return invalidWsToken('Node token cannot open the workspace stream');
  }

  if (tokenKind === 'observer') {
    const result = await deps.auth.authenticate({ token, require: 'observer', db: deps.db });
    if (!result.ok || !result.observerToken) {
      return invalidWsToken('Invalid observer token');
    }
    if (!hasObserverScope(result.observerToken, 'stream:read')) {
      return invalidWsToken('Observer token lacks stream:read');
    }
    return { ok: true, scope: 'workspace', workspace: result.workspace, observerToken: result.observerToken };
  }

  return invalidWsToken('Invalid token format');
}

export async function authenticateNodeWs(deps: WsAuthDeps, token: string): Promise<NodeWsAuthResult> {
  if (getAuthTokenKind(token) !== 'node') {
    return invalidWsToken('Invalid node token format');
  }

  const hash = await deps.auth.hashToken(token);
  const node = await getNodeByTokenHash(deps.db, hash);
  if (!node) {
    return invalidWsToken('Invalid node token');
  }

  return { ok: true, node };
}
