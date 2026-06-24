import type { EngineConfig } from '../ports/index.js';
import type { AuthProvider, Agent, Workspace } from '../ports/auth.js';
import type { EngineDb } from '../ports/database.js';
import type { KeyValueStore } from '../ports/kv.js';
import { getNodeByTokenHash } from './node.js';
import { isFleetNodesEnabled } from '../lib/fleetNodes.js';
import { isWorkspaceStreamEnabled } from '../lib/workspaceStream.js';

type WsAuthErrorCode = 'unauthorized' | 'invalid_token' | 'not_found' | 'fleet_nodes_disabled';

export interface WsAuthError {
  ok: false;
  status: 401 | 404;
  code: WsAuthErrorCode;
  message: string;
  upgradeMessage: 'Unauthorized' | 'Not Found';
}

export type RealtimeWsAuthResult =
  | { ok: true; scope: 'agent'; workspace: Workspace; agent: Agent }
  | { ok: true; scope: 'workspace'; workspace: Workspace }
  | WsAuthError;

export type NodeWsAuthResult =
  | {
      ok: true;
      node: Awaited<ReturnType<typeof getNodeByTokenHash>>;
    }
  | WsAuthError;

interface WsAuthDeps {
  auth: AuthProvider;
  db: EngineDb;
  kv: KeyValueStore;
  config?: EngineConfig;
}

export function extractBearerToken(authHeader: string | undefined): string | undefined {
  return authHeader && /^bearer\s+/i.test(authHeader)
    ? authHeader.replace(/^bearer\s+/i, '').trim()
    : undefined;
}

export function queryOrBearerToken(queryToken: string | null | undefined, authHeader: string | undefined): string | undefined {
  return queryToken ?? extractBearerToken(authHeader);
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

function notFoundWsToken(code: WsAuthErrorCode, message: string): WsAuthError {
  return {
    ok: false,
    status: 404,
    code,
    message,
    upgradeMessage: 'Not Found',
  };
}

export async function authenticateRealtimeWs(deps: WsAuthDeps, token: string): Promise<RealtimeWsAuthResult> {
  if (token.startsWith('at_live_')) {
    const result = await deps.auth.authenticate({ token, require: 'agent', db: deps.db });
    if (!result.ok || !result.agent) {
      return invalidWsToken('Invalid agent token');
    }
    return { ok: true, scope: 'agent', workspace: result.workspace, agent: result.agent };
  }

  if (token.startsWith('rk_live_')) {
    const result = await deps.auth.authenticate({ token, require: 'workspace', db: deps.db });
    if (!result.ok) {
      return invalidWsToken('Invalid workspace key');
    }
    if (!(await isWorkspaceStreamEnabled(deps.kv, result.workspace.id, deps.config?.workspaceStreamEnabled ?? false))) {
      return notFoundWsToken('not_found', 'Workspace stream is disabled');
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

  if (!(await isFleetNodesEnabled(deps.kv, node.workspaceId, deps.config?.fleetNodesEnabled ?? false))) {
    return notFoundWsToken('fleet_nodes_disabled', 'Fleet nodes are disabled for this workspace');
  }

  return { ok: true, node };
}
