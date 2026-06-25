import type { AuthProvider, Workspace } from '../ports/auth.js';
import type { EngineDb } from '../ports/database.js';
import { getNodeByTokenHash } from './node.js';

type WsAuthErrorCode = 'unauthorized' | 'invalid_token';

export interface WsAuthError {
  ok: false;
  status: 401;
  code: WsAuthErrorCode;
  message: string;
  upgradeMessage: 'Unauthorized';
}

export type RealtimeWsAuthResult =
  | { ok: true; scope: 'workspace'; workspace: Workspace }
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
  if (token.startsWith('at_live_')) {
    return invalidWsToken('Agent realtime WebSockets have moved to node transport');
  }

  if (token.startsWith('rk_live_')) {
    const result = await deps.auth.authenticate({ token, require: 'workspace', db: deps.db });
    if (!result.ok) {
      return invalidWsToken('Invalid workspace key');
    }
    return { ok: true, scope: 'workspace', workspace: result.workspace };
  }

  return invalidWsToken('Invalid token format');
}

export async function authenticateNodeWs(deps: WsAuthDeps, token: string): Promise<NodeWsAuthResult> {
  if (!token.startsWith('nt_live_')) {
    return invalidWsToken('Invalid node token format');
  }

  const hash = await deps.auth.hashToken(token);
  const node = await getNodeByTokenHash(deps.db, hash);
  if (!node) {
    return invalidWsToken('Invalid node token');
  }

  return { ok: true, node };
}
