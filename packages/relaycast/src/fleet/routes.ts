import type { CloudflareBindings } from '../env.js';
import { generateFleetId, randomHex, sha256Hex } from './crypto.js';
import { normalizeCapabilities } from './wire.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

type AuthResult =
  | { ok: true; workspaceId: string; workspaceName: string; tokenKind: 'workspace' | 'agent'; agentId?: string; agentName?: string }
  | { ok: false; response: Response };

type NodeRow = {
  id: string;
  workspace_id: string;
  name: string;
  token_hash: string;
  capabilities: string;
  max_agents: number;
  active_agents: number;
  tags: string;
  version: string;
  status: string;
  handlers_live: number;
  load: number;
  last_heartbeat_at: number | null;
  created_at: number;
};

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization') ?? request.headers.get('Authorization');
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  return match?.[1]?.trim() || null;
}

// The relay broker authenticates the /v1/node/ws upgrade with an
// `Authorization: Bearer <nt_live_…>` header (crates/broker/src/node_control.rs).
// Browsers and some SDK/Pear clients cannot set headers on a WebSocket
// handshake, so we also honor a `?token=` query credential — but ONLY on this
// upgrade path. The header takes precedence when both are present.
function nodeWsToken(request: Request): string | null {
  const header = bearerToken(request);
  if (header) return header;
  const query = new URL(request.url).searchParams.get('token')?.trim();
  return query || null;
}

function configuredInternalSecret(env: CloudflareBindings): string | null {
  const value = env.RELAYCAST_INTERNAL_SECRET?.trim() ?? '';
  return value && value !== 'unset' ? value : null;
}

async function timingSafeSecretEqual(actual: string, expected: string): Promise<boolean> {
  const [actualHash, expectedHash] = await Promise.all([sha256Hex(actual), sha256Hex(expected)]);
  let diff = 0;
  for (let i = 0; i < expectedHash.length; i += 1) {
    diff |= actualHash.charCodeAt(i) ^ expectedHash.charCodeAt(i);
  }
  return diff === 0;
}

async function authenticateInternal(request: Request, env: CloudflareBindings): Promise<Response | null> {
  const expected = configuredInternalSecret(env);
  if (!expected) {
    return json(
      { ok: false, error: { code: 'internal_secret_unconfigured', message: 'Internal maintenance API is not configured' } },
      { status: 503 },
    );
  }
  if (!(await timingSafeSecretEqual(bearerToken(request) ?? '', expected))) {
    return json(
      { ok: false, error: { code: 'unauthorized', message: 'Invalid internal token' } },
      { status: 401 },
    );
  }
  return null;
}

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, { ...init, headers: { ...JSON_HEADERS, ...init?.headers } });
}

function parseJsonArray(value: string | null | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isLive(row: NodeRow): boolean {
  if (row.status !== 'online' || !row.last_heartbeat_at) return false;
  return Date.now() - row.last_heartbeat_at * 1000 <= 45_000;
}

function publicNode(row: NodeRow): Record<string, unknown> {
  const live = isLive(row);
  return {
    id: row.id,
    name: row.name,
    capabilities: parseJsonArray(row.capabilities),
    tags: parseJsonArray(row.tags),
    version: row.version,
    status: live ? 'online' : 'offline',
    live,
    handlers_live: live && row.handlers_live === 1,
    load: row.load,
    active_agents: row.active_agents,
    max_agents: row.max_agents,
    last_heartbeat_at: row.last_heartbeat_at ? new Date(row.last_heartbeat_at * 1000).toISOString() : null,
    created_at: new Date(row.created_at * 1000).toISOString(),
  };
}

async function authenticate(request: Request, env: CloudflareBindings): Promise<AuthResult> {
  const token = bearerToken(request);
  if (!token) {
    return { ok: false, response: json({ ok: false, error: { code: 'unauthorized', message: 'Bearer token required' } }, { status: 401 }) };
  }
  const tokenHash = await sha256Hex(token);

  if (token.startsWith('rk_live_')) {
    const workspace = await env.DB
      .prepare('SELECT id, name FROM workspaces WHERE api_key_hash = ? LIMIT 1')
      .bind(tokenHash)
      .first<{ id: string; name: string }>();
    if (!workspace) {
      return { ok: false, response: json({ ok: false, error: { code: 'unauthorized', message: 'Invalid API key' } }, { status: 401 }) };
    }
    return { ok: true, workspaceId: workspace.id, workspaceName: workspace.name, tokenKind: 'workspace' };
  }

  if (token.startsWith('at_live_')) {
    const row = await env.DB
      .prepare(`
        SELECT a.id AS agent_id, a.name AS agent_name, w.id AS workspace_id, w.name AS workspace_name
        FROM agents a
        JOIN workspaces w ON w.id = a.workspace_id
        WHERE a.token_hash = ?
        LIMIT 1
      `)
      .bind(tokenHash)
      .first<{ agent_id: string; agent_name: string; workspace_id: string; workspace_name: string }>();
    if (!row) {
      return { ok: false, response: json({ ok: false, error: { code: 'unauthorized', message: 'Invalid agent token' } }, { status: 401 }) };
    }
    return {
      ok: true,
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      tokenKind: 'agent',
      agentId: row.agent_id,
      agentName: row.agent_name,
    };
  }

  return { ok: false, response: json({ ok: false, error: { code: 'unauthorized', message: 'Invalid token format' } }, { status: 401 }) };
}

function normalizeNodeName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^#/, '');
  return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : null;
}

function capabilityMatches(capabilities: unknown[], capability: string): boolean {
  return capabilities.some((entry) => {
    if (typeof entry === 'string') return entry === capability;
    return !!entry && typeof entry === 'object' && (entry as { name?: unknown }).name === capability;
  });
}

async function handleCreateNode(request: Request, env: CloudflareBindings, auth: Extract<AuthResult, { ok: true }>): Promise<Response> {
  if (auth.tokenKind !== 'workspace') {
    return json({ ok: false, error: { code: 'workspace_key_required', message: 'Workspace key required' } }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('invalid body');
    }
  } catch {
    return json({ ok: false, error: { code: 'invalid_request', message: 'Invalid JSON body' } }, { status: 400 });
  }

  const name = normalizeNodeName(body.name);
  if (!name) {
    return json({ ok: false, error: { code: 'invalid_request', message: 'name is required' } }, { status: 400 });
  }

  const capabilities = normalizeCapabilities(body.capabilities);
  const maxAgents = typeof body.max_agents === 'number' && Number.isInteger(body.max_agents) && body.max_agents >= 0
    ? body.max_agents
    : 0;
  const tags = Array.isArray(body.tags)
    ? [...new Set(body.tags.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.trim()).filter(Boolean))]
    : [];
  const version = typeof body.version === 'string' && body.version.trim() ? body.version.trim() : 'unknown';
  const nodeId = typeof body.node_id === 'string' && body.node_id.trim() ? body.node_id.trim() : generateFleetId('node');
  const token = `nt_live_${randomHex(24)}`;
  const tokenHash = await sha256Hex(token);

  const existing = await env.DB
    .prepare('SELECT * FROM nodes WHERE workspace_id = ? AND name = ? LIMIT 1')
    .bind(auth.workspaceId, name)
    .first<NodeRow>();

  if (existing) {
    await env.DB
      .prepare(`
        UPDATE nodes
        SET token_hash = ?, capabilities = ?, max_agents = ?, tags = ?, version = ?,
            status = 'offline', handlers_live = 0, load = 0, active_agents = 0
        WHERE id = ?
      `)
      .bind(tokenHash, JSON.stringify(capabilities), maxAgents, JSON.stringify(tags), version, existing.id)
      .run();
    const updated = await env.DB.prepare('SELECT * FROM nodes WHERE id = ?').bind(existing.id).first<NodeRow>();
    return json({ ok: true, data: { ...publicNode(updated ?? existing), token } }, { status: 201 });
  }

  const now = Math.floor(Date.now() / 1000);
  await env.DB
    .prepare(`
      INSERT INTO nodes (id, workspace_id, name, token_hash, capabilities, max_agents, active_agents, tags, version, status, handlers_live, load, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'offline', 0, 0, ?)
    `)
    .bind(nodeId, auth.workspaceId, name, tokenHash, JSON.stringify(capabilities), maxAgents, JSON.stringify(tags), version, now)
    .run();
  const row = await env.DB.prepare('SELECT * FROM nodes WHERE id = ?').bind(nodeId).first<NodeRow>();
  return json({ ok: true, data: { ...publicNode(row as NodeRow), token } }, { status: 201 });
}

async function listNodes(request: Request, env: CloudflareBindings, auth: Extract<AuthResult, { ok: true }>): Promise<Response> {
  const url = new URL(request.url);
  const capability = url.searchParams.get('capability');
  const name = url.searchParams.get('name')?.replace(/^#/, '') ?? null;
  const rows = await env.DB
    .prepare('SELECT * FROM nodes WHERE workspace_id = ? ORDER BY name ASC')
    .bind(auth.workspaceId)
    .all<NodeRow>();
  const nodes = (rows.results ?? [])
    .filter((row) => !name || row.name === name)
    .filter((row) => !capability || capabilityMatches(parseJsonArray(row.capabilities), capability))
    .map(publicNode);
  return json({ ok: true, data: nodes });
}

async function getNodeByName(_request: Request, env: CloudflareBindings, auth: Extract<AuthResult, { ok: true }>, name: string): Promise<Response> {
  const row = await env.DB
    .prepare('SELECT * FROM nodes WHERE workspace_id = ? AND name = ? LIMIT 1')
    .bind(auth.workspaceId, name.replace(/^#/, ''))
    .first<NodeRow>();
  if (!row) {
    return json({ ok: false, error: { code: 'node_not_found', message: 'Node not found' } }, { status: 404 });
  }
  return json({ ok: true, data: publicNode(row) });
}

async function handleNodeWs(request: Request, env: CloudflareBindings): Promise<Response> {
  const token = nodeWsToken(request);
  if (!token?.startsWith('nt_live_')) {
    return new Response('Node token required', { status: 401 });
  }
  const tokenHash = await sha256Hex(token);
  const node = await env.DB
    .prepare('SELECT id, workspace_id, name FROM nodes WHERE token_hash = ? LIMIT 1')
    .bind(tokenHash)
    .first<{ id: string; workspace_id: string; name: string }>();
  if (!node) {
    return new Response('Invalid node token', { status: 401 });
  }

  const url = new URL(request.url);
  url.pathname = '/ws';
  // Don't forward the node credential past the auth boundary into the DO.
  url.searchParams.delete('token');
  url.searchParams.set('workspace_id', node.workspace_id);
  url.searchParams.set('node_id', node.id);
  url.searchParams.set('node_name', node.name);
  const stub = env.NODE_DO.get(env.NODE_DO.idFromName(`${node.workspace_id}:${node.id}`));
  return stub.fetch(new Request(url.toString(), request));
}

async function ensureWorkspaceKey(
  request: Request,
  env: CloudflareBindings,
  workspaceId: string,
): Promise<Response> {
  if (request.method !== 'POST') {
    return json(
      { ok: false, error: { code: 'method_not_allowed', message: 'Method not allowed' } },
      { status: 405 },
    );
  }

  const authError = await authenticateInternal(request, env);
  if (authError) return authError;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('invalid body');
    }
  } catch {
    return json({ ok: false, error: { code: 'invalid_request', message: 'Invalid JSON body' } }, { status: 400 });
  }

  const apiKey = typeof body.api_key === 'string' ? body.api_key.trim() : '';
  if (!apiKey.startsWith('rk_live_')) {
    return json(
      { ok: false, error: { code: 'invalid_request', message: 'api_key must be an rk_live workspace key' } },
      { status: 400 },
    );
  }

  const workspace = await env.DB
    .prepare('SELECT id FROM workspaces WHERE id = ? LIMIT 1')
    .bind(workspaceId)
    .first<{ id: string }>();
  if (!workspace) {
    return json(
      { ok: false, error: { code: 'workspace_not_found', message: 'Workspace not found' } },
      { status: 404 },
    );
  }

  const apiKeyHash = await sha256Hex(apiKey);
  await env.DB
    .prepare('UPDATE workspaces SET api_key_hash = ? WHERE id = ?')
    .bind(apiKeyHash, workspace.id)
    .run();

  return json({ ok: true, data: { workspace_id: workspace.id } });
}

export async function handleFleetGatewayRequest(request: Request, env: CloudflareBindings): Promise<Response | null> {
  const url = new URL(request.url);
  const ensureKeyMatch = /^\/internal\/workspaces\/([^/]+)\/api-key$/.exec(url.pathname);
  if (ensureKeyMatch) {
    return ensureWorkspaceKey(request, env, decodeURIComponent(ensureKeyMatch[1]!));
  }

  if (request.method === 'GET' && url.pathname === '/v1/node/ws') {
    return handleNodeWs(request, env);
  }

  if (url.pathname === '/v1/nodes' || url.pathname.startsWith('/v1/nodes/')) {
    const auth = await authenticate(request, env);
    if (!auth.ok) return auth.response;

    if (request.method === 'POST' && url.pathname === '/v1/nodes') {
      return handleCreateNode(request, env, auth);
    }
    if (request.method === 'GET' && url.pathname === '/v1/nodes') {
      return listNodes(request, env, auth);
    }
    if (request.method === 'GET' && url.pathname.startsWith('/v1/nodes/')) {
      return getNodeByName(request, env, auth, decodeURIComponent(url.pathname.slice('/v1/nodes/'.length)));
    }
  }

  return null;
}
