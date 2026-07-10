import type { CloudflareBindings } from '../env.js';
import type { NodeConnectionRegistry } from '@relaycast/engine/ports';
import { generateFleetId, randomHex, sha256Hex } from '../fleet/crypto.js';
import {
  errorFrame,
  normalizeCapabilities,
  parseFleetBrokerMessage,
  replyFrame,
  toFleetJson,
  type FleetBrokerMessage,
  type FleetCapability,
  type FleetRelaycastMessage,
} from '../fleet/wire.js';

type ToNodeMessage = Parameters<NodeConnectionRegistry['sendToNode']>[2];

const NODE_LIVENESS_TTL_MS = 45_000;
const NODE_SWEEP_ALARM_MS = 30_000;
// Mirrors relaycast#192 ACTION_DISPATCH_TIMEOUT_MS: an invocation dispatched to a
// live node that never replies is re-dispatched after this window.
const ACTION_DISPATCH_TIMEOUT_MS = 30_000;
const INVOCATION_SWEEP_BATCH = 200;

type NodeMeta = {
  workspaceId?: string;
  nodeId?: string;
  nodeName?: string;
};

type NodeRow = {
  id: string;
  name: string;
  capabilities: string;
  max_agents: number;
  active_agents: number;
  reserved_agents?: number;
  tags: string;
  version: string;
  status: string;
  handlers_live: number;
  load: number;
  last_heartbeat_at: number | null;
  created_at: number;
};

type ActionInvocationRow = {
  id: string;
  status: string;
  action_name: string;
  input: string | null;
  dispatched_node_id: string | null;
  attempted_node_ids: string | null;
  dispatch_attempts: number;
};

type DeliveryAckRow = {
  delivery_id: string;
  message_id: string;
  channel_id: string;
};

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function send(ws: WebSocket | undefined, payload: FleetRelaycastMessage): void {
  if (!ws) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // Close handling marks the node offline.
  }
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

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function capabilityName(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string') {
    return (value as { name: string }).name;
  }
  return null;
}

function nodeHasCapability(row: Pick<NodeRow, 'capabilities'>, actionName: string): boolean {
  return parseJsonArray(row.capabilities).some((capability) => capabilityName(capability) === actionName);
}

function isLiveNode(row: Pick<NodeRow, 'status' | 'handlers_live' | 'last_heartbeat_at'>): boolean {
  return (
    row.status === 'online' &&
    row.handlers_live === 1 &&
    !!row.last_heartbeat_at &&
    Date.now() - row.last_heartbeat_at * 1000 <= NODE_LIVENESS_TTL_MS
  );
}

function retryAfterSeconds(attempts: number): number {
  const backoffMs = Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 60_000);
  return nowSeconds() + Math.ceil(backoffMs / 1000);
}

function publicNode(row: NodeRow) {
  const live = row.status === 'online' && !!row.last_heartbeat_at && Date.now() - row.last_heartbeat_at * 1000 <= NODE_LIVENESS_TTL_MS;
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

async function ensureCapabilityActions(env: CloudflareBindings, workspaceId: string, nodeId: string, capabilities: FleetCapability[]): Promise<void> {
  for (const capability of capabilities) {
    const name = capability.name;
    if (!name || name.startsWith('spawn:')) continue;
    const existing = await env.DB
      .prepare('SELECT id, handler_agent_id, handler_node_id FROM actions WHERE workspace_id = ? AND name = ? LIMIT 1')
      .bind(workspaceId, name)
      .first<{ id: string; handler_agent_id: string | null; handler_node_id: string | null }>();
    if (!existing) {
      await env.DB
        .prepare(`
          INSERT INTO actions (id, workspace_id, name, description, handler_agent_id, handler_node_id, input_schema, output_schema, available_to, is_active, created_at)
          VALUES (?, ?, ?, ?, NULL, ?, '{}', '{}', NULL, 1, ?)
        `)
        .bind(generateFleetId('act'), workspaceId, name, `Node handler ${name}`, nodeId, nowSeconds())
        .run();
    } else if (!existing.handler_agent_id && (!existing.handler_node_id || existing.handler_node_id === nodeId)) {
      await env.DB
        .prepare('UPDATE actions SET handler_node_id = ?, is_active = 1 WHERE id = ?')
        .bind(nodeId, existing.id)
        .run();
    }
  }
}

export async function markNodeOffline(env: CloudflareBindings, workspaceId: string, nodeId: string): Promise<void> {
  await env.DB
    .prepare(`
      UPDATE nodes
      SET status = 'offline', handlers_live = 0, load = 0, active_agents = 0, last_heartbeat_at = ?
      WHERE workspace_id = ? AND id = ?
    `)
    .bind(nowSeconds(), workspaceId, nodeId)
    .run();
  await env.DB
    .prepare(`
      UPDATE agents
      SET status = 'offline', last_seen = ?
      WHERE workspace_id = ? AND location_type = 'via_node' AND location_node_id = ?
    `)
    .bind(nowSeconds(), workspaceId, nodeId)
    .run();
  await rescheduleInvocationsForNode(env, workspaceId, nodeId);
}

async function registerAgentViaNode(
  env: CloudflareBindings,
  workspaceId: string,
  nodeId: string,
  message: Extract<FleetBrokerMessage, { type: 'agent.register' }>,
) {
  const token = `at_live_${randomHex(16)}`;
  const tokenHash = await sha256Hex(token);
  const name = message.name.trim();
  const now = nowSeconds();
  const existing = await env.DB
    .prepare('SELECT id, status, location_type, location_node_id, origin_node_id FROM agents WHERE workspace_id = ? AND name = ? LIMIT 1')
    .bind(workspaceId, name)
    .first<{ id: string; status: string; location_type?: string; location_node_id?: string; origin_node_id?: string | null }>();

  if (existing && existing.status === 'active' && existing.location_type !== 'via_node') {
    throw new Error(`Agent "${name}" already has an active location`);
  }
  if (existing && existing.status === 'active' && existing.location_type === 'via_node' && existing.location_node_id !== nodeId) {
    throw new Error(`Agent "${name}" already has an active location`);
  }

  let agentId = existing?.id;
  const fleetMetadata = JSON.stringify({
    fleet: {
      node_id: nodeId,
      invocation_id: message.invocation_id ?? null,
      registered_at: new Date(now * 1000).toISOString(),
    },
  });
  if (agentId) {
    await env.DB
      .prepare(`
        UPDATE agents
        SET token_hash = ?, status = 'active', last_seen = ?, metadata = ?,
            location_type = 'via_node', location_node_id = ?, origin_node_id = COALESCE(origin_node_id, ?),
            resumable = ?, session_ref = ?
        WHERE id = ?
      `)
      .bind(tokenHash, now, fleetMetadata, nodeId, nodeId, message.resumable ? 1 : 0, message.session_ref ?? null, agentId)
      .run();
  } else {
    agentId = generateFleetId('agent');
    await env.DB
      .prepare(`
        INSERT INTO agents (id, workspace_id, name, type, token_hash, status, persona, metadata, created_at, last_seen, handle, capabilities, location_type, location_node_id, origin_node_id, resumable, session_ref)
        VALUES (?, ?, ?, 'agent', ?, 'active', NULL, ?, ?, ?, ?, NULL, 'via_node', ?, ?, ?, ?)
      `)
      .bind(
        agentId,
        workspaceId,
        name,
        tokenHash,
        fleetMetadata,
        now,
        now,
        `@${name}`,
        nodeId,
        nodeId,
        message.resumable ? 1 : 0,
        message.session_ref ?? null,
      )
      .run();
  }

  const general = await env.DB
    .prepare("SELECT id FROM channels WHERE workspace_id = ? AND name = 'general' LIMIT 1")
    .bind(workspaceId)
    .first<{ id: string }>();
  if (general) {
    await env.DB
      .prepare('INSERT OR IGNORE INTO channel_members (channel_id, agent_id, role) VALUES (?, ?, ?)')
      .bind(general.id, agentId, 'member')
      .run();
  }

  return {
    agent_id: agentId,
    name,
    token,
  };
}

type InventoryAgent = { agent_id: string; name: string; invocation_id?: string; session_ref?: string };

/**
 * Reconcile a node's reported agent inventory, enforcing single-active-location.
 *
 * The guard mirrors registerAgentViaNode: a name is only (re)claimed for this
 * node when it is already bound to this node, not currently active, or a
 * via_node binding with no node. An agent that is active and self_connected, or
 * actively bound to a DIFFERENT live node, is NOT hijacked — it is reported in
 * `rejected_agents`. Agents previously on this node but absent from the reported
 * inventory are marked offline.
 */
export async function reconcileNodeInventory(
  env: CloudflareBindings,
  workspaceId: string,
  nodeId: string,
  agents: InventoryAgent[],
): Promise<{ rebound_agents: number; rejected_agents: string[] }> {
  const names = new Set(agents.map((agent) => agent.name));
  const statements = agents.map((agent) =>
    env.DB.prepare(`
        UPDATE agents
        SET status = 'active', last_seen = ?, location_type = 'via_node', location_node_id = ?,
            origin_node_id = COALESCE(origin_node_id, ?), session_ref = COALESCE(?, session_ref)
        WHERE workspace_id = ? AND name = ?
          AND (
            location_node_id = ?
            OR status != 'active'
            OR (location_type = 'via_node' AND location_node_id IS NULL)
          )
      `)
      .bind(nowSeconds(), nodeId, nodeId, agent.session_ref ?? null, workspaceId, agent.name, nodeId),
  );
  if (statements.length > 0) {
    await env.DB.batch(statements);
  }

  const active = await env.DB
    .prepare(`
      SELECT id, name FROM agents
      WHERE workspace_id = ? AND location_type = 'via_node' AND location_node_id = ? AND status = 'active'
    `)
    .bind(workspaceId, nodeId)
    .all<{ id: string; name: string }>();
  const boundToThisNode = new Set((active.results ?? []).map((agent) => agent.name));
  for (const agent of active.results ?? []) {
    if (!names.has(agent.name)) {
      await env.DB.prepare("UPDATE agents SET status = 'offline', last_seen = ? WHERE id = ?").bind(nowSeconds(), agent.id).run();
    }
  }

  // Requested names that are NOT bound to this node after the guarded claim are
  // agents actively located elsewhere — surface them as rejected rather than
  // silently pretending the rebind succeeded.
  const rejected = [...names].filter((name) => !boundToThisNode.has(name));
  return { rebound_agents: boundToThisNode.size, rejected_agents: rejected };
}

export async function completeActionInvocation(
  env: CloudflareBindings,
  workspaceId: string,
  nodeId: string,
  message: Extract<FleetBrokerMessage, { type: 'action.result' }>,
): Promise<void> {
  const existing = await env.DB
    .prepare(`
      SELECT id, status, action_name, input, dispatched_node_id, attempted_node_ids, dispatch_attempts
      FROM action_invocations
      WHERE workspace_id = ? AND id = ?
      LIMIT 1
    `)
    .bind(workspaceId, message.invocation_id)
    .first<ActionInvocationRow>();
  if (!existing || existing.status === 'completed' || existing.status === 'failed') return;

  // First-COMPLETED-wins (not last-dispatched-wins): a result from any node this
  // invocation was ever dispatched to is recognized. A result from a node that
  // never handled this invocation is ignored outright.
  const isCurrentNode = existing.dispatched_node_id === nodeId || !existing.dispatched_node_id;
  const recognized = isCurrentNode || attemptedNodeIds(existing, nodeId).includes(nodeId);
  if (!recognized) return;

  if (message.error === 'handler_unavailable') {
    // Only the node we currently believe owns the attempt may bounce it back for
    // reschedule; a late handler_unavailable from a node we already rescheduled
    // away from must not re-trigger another reschedule.
    if (!isCurrentNode) return;
    await env.DB
      .prepare('UPDATE nodes SET handlers_live = 0 WHERE workspace_id = ? AND id = ?')
      .bind(workspaceId, nodeId)
      .run();
    await rescheduleActionInvocation(env, workspaceId, nodeId, existing);
    return;
  }

  // A non-handler_unavailable error from a node that has been superseded by a
  // reschedule must not fail an invocation the current node still owns. A
  // SUCCESS from a superseded node, however, still wins — it genuinely completed
  // the work — and the status CAS below records only the first terminal result.
  if (message.error && !isCurrentNode) return;

  await env.DB
    .prepare(`
      UPDATE action_invocations
      SET output = ?, error = ?, status = ?, completed_at = ?
      WHERE workspace_id = ? AND id = ? AND (status = 'pending' OR status = 'dispatched')
    `)
    .bind(
      message.output === undefined ? null : JSON.stringify(message.output),
      message.error ?? null,
      message.error ? 'failed' : 'completed',
      nowSeconds(),
      workspaceId,
      message.invocation_id,
    )
    .run();
}

async function eligibleNodeCandidates(
  env: CloudflareBindings,
  workspaceId: string,
  actionName: string,
  excludeNodeIds: Set<string>,
): Promise<NodeRow[]> {
  const rows = await env.DB
    .prepare(`
      SELECT *
      FROM nodes
      WHERE workspace_id = ? AND status = 'online' AND handlers_live = 1
      ORDER BY load ASC, active_agents ASC, name ASC
    `)
    .bind(workspaceId)
    .all<NodeRow>();
  return (rows.results ?? [])
    .filter((node) => !excludeNodeIds.has(node.id))
    .filter((node) => isLiveNode(node))
    // `reserved_agents` is incremented exclusively by the node-aware engine's
    // spawn-capacity reservation (relaycast#192 placement.ts). Cloud's fallback
    // and trigger dispatch never targets `spawn:` actions (ensureCapabilityActions
    // skips them), so cloud never reserves capacity itself — but it reads the
    // column here so that, once the engine is linked, cloud reschedule respects
    // reservations the engine holds rather than over-committing a node.
    .filter((node) => node.max_agents === 0 || node.active_agents + (node.reserved_agents ?? 0) < node.max_agents)
    .filter((node) => nodeHasCapability(node, actionName));
}

function attemptedNodeIds(invocation: ActionInvocationRow, currentNodeId: string): string[] {
  return Array.from(new Set([
    ...parseJsonArray(invocation.attempted_node_ids).filter((entry): entry is string => typeof entry === 'string'),
    invocation.dispatched_node_id,
    currentNodeId,
  ].filter((entry): entry is string => !!entry)));
}

async function markInvocationPendingRetry(
  env: CloudflareBindings,
  workspaceId: string,
  invocation: ActionInvocationRow,
  attempted: string[],
): Promise<void> {
  await env.DB
    .prepare(`
      UPDATE action_invocations
      SET status = 'pending',
          dispatched_node_id = NULL,
          dispatched_at = NULL,
          attempted_node_ids = ?,
          retry_after_at = ?,
          spawn_reserved_at = NULL
      WHERE workspace_id = ? AND id = ? AND status IN ('pending', 'dispatched', 'invoked')
    `)
    .bind(
      JSON.stringify(attempted),
      retryAfterSeconds(invocation.dispatch_attempts + 1),
      workspaceId,
      invocation.id,
    )
    .run();
}

async function rescheduleActionInvocation(
  env: CloudflareBindings,
  workspaceId: string,
  failedNodeId: string,
  invocation: ActionInvocationRow,
): Promise<boolean> {
  const attempted = attemptedNodeIds(invocation, failedNodeId);
  const candidates = await eligibleNodeCandidates(env, workspaceId, invocation.action_name, new Set(attempted));
  const input = parseJsonObject(invocation.input);

  for (const candidate of candidates) {
    const delivered = await sendToNode(env, workspaceId, candidate.id, {
      v: 1,
      type: 'action.invoke',
      invocation_id: invocation.id,
      action: invocation.action_name,
      input: toFleetJson(input),
    });
    const nextAttempted = Array.from(new Set([...attempted, candidate.id]));
    if (!delivered) {
      attempted.push(candidate.id);
      continue;
    }

    await env.DB
      .prepare(`
        UPDATE action_invocations
        SET status = 'dispatched',
            dispatched_node_id = ?,
            dispatched_at = ?,
            attempted_node_ids = ?,
            dispatch_attempts = COALESCE(dispatch_attempts, 0) + 1,
            retry_after_at = NULL
        WHERE workspace_id = ? AND id = ? AND status IN ('pending', 'dispatched', 'invoked')
      `)
      .bind(candidate.id, nowSeconds(), JSON.stringify(nextAttempted), workspaceId, invocation.id)
      .run();
    return true;
  }

  await markInvocationPendingRetry(env, workspaceId, invocation, attempted);
  return false;
}

async function rescheduleInvocationsForNode(env: CloudflareBindings, workspaceId: string, nodeId: string): Promise<void> {
  const rows = await env.DB
    .prepare(`
      SELECT id, status, action_name, input, dispatched_node_id, attempted_node_ids, dispatch_attempts
      FROM action_invocations
      WHERE workspace_id = ? AND dispatched_node_id = ? AND status IN ('pending', 'dispatched', 'invoked')
    `)
    .bind(workspaceId, nodeId)
    .all<ActionInvocationRow>();
  for (const invocation of rows.results ?? []) {
    await rescheduleActionInvocation(env, workspaceId, nodeId, invocation);
  }
}

/**
 * Re-dispatch sweep, mirroring relaycast#192 `sweepTimedOutInvocations`. Without
 * this, `retry_after_at` is written by the reschedule path but never read, so any
 * invocation that could not be placed immediately strands in `pending` forever,
 * and an invocation `dispatched` to a live node that silently never replies stays
 * `dispatched` indefinitely. The sweep picks up both:
 *   - `dispatched` rows whose `dispatched_at` is older than the dispatch timeout
 *     (node accepted the frame but never returned a result), and
 *   - `pending` rows whose `retry_after_at` has elapsed (no eligible node was
 *     available when the invocation was last (re)queued).
 * It runs from the worker `scheduled()` cron across all workspaces. Each row is
 * funneled back through `rescheduleActionInvocation`, whose status CAS makes the
 * sweep idempotent even when several cron ticks or node alarms overlap.
 */
export async function sweepFleetInvocations(env: CloudflareBindings, nowMs: number = Date.now()): Promise<number> {
  const now = Math.floor(nowMs / 1000);
  const dispatchCutoff = Math.floor((nowMs - ACTION_DISPATCH_TIMEOUT_MS) / 1000);
  const rows = await env.DB
    .prepare(`
      SELECT id, workspace_id, status, action_name, input, dispatched_node_id, attempted_node_ids, dispatch_attempts
      FROM action_invocations
      WHERE (status = 'dispatched' AND dispatched_at IS NOT NULL AND dispatched_at <= ?)
         OR (status = 'pending' AND retry_after_at IS NOT NULL AND retry_after_at <= ?)
      ORDER BY COALESCE(retry_after_at, dispatched_at) ASC
      LIMIT ?
    `)
    .bind(dispatchCutoff, now, INVOCATION_SWEEP_BATCH)
    .all<ActionInvocationRow & { workspace_id: string }>();

  let rescheduled = 0;
  for (const invocation of rows.results ?? []) {
    try {
      if (await rescheduleActionInvocation(env, invocation.workspace_id, invocation.dispatched_node_id ?? '', invocation)) {
        rescheduled += 1;
      }
    } catch {
      // Leave the invocation for the next sweep tick.
    }
  }
  return rescheduled;
}

/**
 * Drain queued invocations for a node that just came (back) online. Cloud has no
 * per-node frame queue — frames go out eagerly via sendToNode — so a "drain" is
 * the act of giving a freshly-online node a chance to pick up invocations that
 * were left `pending` because no eligible node was available when they were last
 * queued. This is the cloud realization of relaycast#192's
 * `NodeConnectionRegistry.drainNode`, invoked after node.register/heartbeat marks
 * the node online. Placement still runs through `rescheduleActionInvocation`, so
 * the node is only chosen if it is genuinely eligible (capability + capacity).
 */
export async function drainNodeInvocations(env: CloudflareBindings, workspaceId: string, nodeId: string): Promise<number> {
  const rows = await env.DB
    .prepare(`
      SELECT ai.id, ai.status, ai.action_name, ai.input, ai.dispatched_node_id, ai.attempted_node_ids, ai.dispatch_attempts
      FROM action_invocations ai
      JOIN actions a ON a.workspace_id = ai.workspace_id AND a.name = ai.action_name AND a.handler_node_id = ?
      WHERE ai.workspace_id = ? AND ai.status = 'pending'
      ORDER BY ai.created_at ASC
      LIMIT ?
    `)
    .bind(nodeId, workspaceId, INVOCATION_SWEEP_BATCH)
    .all<ActionInvocationRow>();

  let dispatched = 0;
  for (const invocation of rows.results ?? []) {
    try {
      if (await rescheduleActionInvocation(env, workspaceId, invocation.dispatched_node_id ?? '', invocation)) {
        dispatched += 1;
      }
    } catch {
      // Leave the invocation for the dispatch sweep.
    }
  }
  return dispatched;
}

export async function ackDeliveriesUpToSeq(
  env: CloudflareBindings,
  workspaceId: string,
  nodeId: string,
  agentName: string,
  upToSeq: number,
): Promise<void> {
  const agent = await env.DB
    .prepare(`
      SELECT id, delivery_ack_seq
      FROM agents
      WHERE workspace_id = ? AND name = ? AND location_type = 'via_node' AND location_node_id = ?
      LIMIT 1
    `)
    .bind(workspaceId, agentName, nodeId)
    .first<{ id: string; delivery_ack_seq: number }>();
  if (!agent || upToSeq <= agent.delivery_ack_seq) return;

  const rows = await env.DB
    .prepare(`
      SELECT d.id AS delivery_id, d.message_id, m.channel_id
      FROM deliveries d
      JOIN messages m ON m.id = d.message_id
      WHERE d.workspace_id = ? AND d.agent_id = ? AND d.seq <= ? AND d.status NOT IN ('acked', 'dead_lettered')
      ORDER BY d.seq ASC
    `)
    .bind(workspaceId, agent.id, upToSeq)
    .all<DeliveryAckRow>();
  const deliveries = rows.results ?? [];
  const now = nowSeconds();
  const statements: D1PreparedStatement[] = [
    env.DB
      .prepare(`
        UPDATE agents
        SET delivery_ack_seq = CASE WHEN delivery_ack_seq < ? THEN ? ELSE delivery_ack_seq END,
            last_seen = ?
        WHERE workspace_id = ? AND id = ?
      `)
      .bind(upToSeq, upToSeq, now, workspaceId, agent.id),
  ];

  for (const row of deliveries) {
    statements.push(
      env.DB
        .prepare(`
          UPDATE deliveries
          SET status = 'acked', acked_at = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ? AND status NOT IN ('acked', 'dead_lettered')
        `)
        .bind(now, now, workspaceId, row.delivery_id),
      env.DB
        .prepare('INSERT OR IGNORE INTO read_receipts (message_id, agent_id, read_at) VALUES (?, ?, ?)')
        .bind(row.message_id, agent.id, now),
      env.DB
        .prepare(`
          UPDATE channel_members
          SET last_read_id = ?
          WHERE channel_id = ? AND agent_id = ?
            AND (last_read_id IS NULL OR CAST(last_read_id AS INTEGER) < CAST(? AS INTEGER))
        `)
        .bind(row.message_id, row.channel_id, agent.id, row.message_id),
    );
  }

  await env.DB.batch(statements);
}

async function handleNodeMessage(
  env: CloudflareBindings,
  workspaceId: string,
  nodeId: string,
  socket: WebSocket,
  message: FleetBrokerMessage,
): Promise<void> {
  switch (message.type) {
    case 'node.register': {
      if (message.node_id !== nodeId) {
        send(socket, errorFrame(message.id, 'node_id_mismatch', 'node_id does not match the authenticated node token'));
        return;
      }
      const existingByName = await env.DB
        .prepare('SELECT id FROM nodes WHERE workspace_id = ? AND name = ? LIMIT 1')
        .bind(workspaceId, message.name)
        .first<{ id: string }>();
      if (existingByName && existingByName.id !== nodeId) {
        send(socket, errorFrame(message.id, 'node_name_conflict', `Node name "${message.name}" is already enrolled`));
        return;
      }
      const capabilities = normalizeCapabilities(message.capabilities);
      await env.DB
        .prepare(`
          UPDATE nodes
          SET name = ?, capabilities = ?, max_agents = ?, tags = ?, version = ?,
              status = 'online', handlers_live = ?, last_heartbeat_at = ?
          WHERE workspace_id = ? AND id = ?
        `)
        .bind(
          message.name,
          JSON.stringify(capabilities),
          message.max_agents,
          JSON.stringify(message.tags),
          message.version,
          capabilities.length > 0 ? 1 : 0,
          nowSeconds(),
          workspaceId,
          nodeId,
        )
        .run();
      await ensureCapabilityActions(env, workspaceId, nodeId, capabilities);
      const row = await env.DB.prepare('SELECT * FROM nodes WHERE workspace_id = ? AND id = ?').bind(workspaceId, nodeId).first<NodeRow>();
      send(socket, replyFrame(message.id, toFleetJson(publicNode(row as NodeRow))));
      return;
    }
    case 'node.heartbeat':
      await env.DB
        .prepare(`
          UPDATE nodes
          SET status = 'online', load = ?, active_agents = ?, handlers_live = ?, last_heartbeat_at = ?
          WHERE workspace_id = ? AND id = ?
        `)
        .bind(message.load, message.active_agents, message.handlers_live ? 1 : 0, nowSeconds(), workspaceId, nodeId)
        .run();
      return;
    case 'node.deregister':
      await markNodeOffline(env, workspaceId, nodeId);
      return;
    case 'agent.register':
      send(socket, replyFrame(message.id, toFleetJson(await registerAgentViaNode(env, workspaceId, nodeId, message))));
      return;
    case 'agent.deregister':
      if (!message.agent_id && !message.name) return;
      await env.DB
        .prepare(`
          UPDATE agents
          SET status = 'offline', last_seen = ?
          WHERE workspace_id = ? AND location_type = 'via_node' AND location_node_id = ?
            AND (? IS NULL OR id = ?)
            AND (? IS NULL OR name = ?)
        `)
        .bind(nowSeconds(), workspaceId, nodeId, message.agent_id ?? null, message.agent_id ?? null, message.name ?? null, message.name ?? null)
        .run();
      return;
    case 'inventory.sync': {
      const result = await reconcileNodeInventory(env, workspaceId, nodeId, message.agents);
      send(socket, replyFrame(message.id, toFleetJson(result)));
      return;
    }
    case 'action.result':
      await completeActionInvocation(env, workspaceId, nodeId, message);
      return;
    case 'delivery.ack':
      await ackDeliveriesUpToSeq(env, workspaceId, nodeId, message.agent, message.up_to_seq);
      return;
  }
}

export class NodeDO implements DurableObject {
  private state: DurableObjectState;
  private env: CloudflareBindings;
  private meta: NodeMeta | null = null;

  constructor(state: DurableObjectState, env: CloudflareBindings) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/ws') {
      return this.handleWebSocketUpgrade(request);
    }
    if (request.method === 'POST' && url.pathname === '/send') {
      return this.handleSend(request);
    }
    if (request.method === 'POST' && url.pathname === '/disconnect') {
      return this.handleDisconnect();
    }
    return new Response('Not Found', { status: 404 });
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const meta: NodeMeta = {
      workspaceId: url.searchParams.get('workspace_id') ?? undefined,
      nodeId: url.searchParams.get('node_id') ?? undefined,
      nodeName: url.searchParams.get('node_name') ?? undefined,
    };
    await this.state.storage.put('meta', meta);
    this.meta = meta;

    for (const socket of this.state.getWebSockets()) {
      try {
        socket.close(4000, 'superseded');
      } catch {
        // Hibernation close events clean up state.
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.state.acceptWebSocket(server);
    await this.state.storage.setAlarm(Date.now() + NODE_SWEEP_ALARM_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleSend(request: Request): Promise<Response> {
    const message = (await request.json()) as FleetRelaycastMessage;
    const socket = this.state.getWebSockets()[0];
    if (!socket) {
      return Response.json({ ok: true, delivered: false });
    }
    send(socket, message);
    return Response.json({ ok: true, delivered: true });
  }

  private async handleDisconnect(): Promise<Response> {
    for (const socket of this.state.getWebSockets()) {
      try {
        socket.close(1000, 'disconnect');
      } catch {
        // Socket may already be closed.
      }
    }
    const meta = await this.getMeta();
    if (meta?.workspaceId && meta.nodeId) {
      await markNodeOffline(this.env, meta.workspaceId, meta.nodeId);
    }
    return Response.json({ ok: true });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    const meta = await this.getMeta();
    if (!meta?.workspaceId || !meta.nodeId) {
      send(ws, errorFrame(undefined, 'node_context_missing', 'Node connection metadata is missing'));
      return;
    }

    let parsed: FleetBrokerMessage;
    try {
      parsed = parseFleetBrokerMessage(message);
    } catch (err) {
      send(ws, errorFrame(undefined, 'invalid_message', err instanceof Error ? err.message : 'Invalid node control message'));
      return;
    }

    try {
      await handleNodeMessage(this.env, meta.workspaceId, meta.nodeId, ws, parsed);
    } catch (err) {
      send(ws, errorFrame(parsed.id, 'node_control_failed', err instanceof Error ? err.message : 'Node control failed'));
    }
  }

  async webSocketClose(): Promise<void> {
    if (this.state.getWebSockets().length > 0) return;
    const meta = await this.getMeta();
    if (meta?.workspaceId && meta.nodeId) {
      await markNodeOffline(this.env, meta.workspaceId, meta.nodeId);
    }
  }

  async webSocketError(): Promise<void> {
    await this.webSocketClose();
  }

  async alarm(): Promise<void> {
    const meta = await this.getMeta();
    // No node context (cold isolate that never upgraded a socket): nothing to
    // sweep and nothing to keep waking for. Do not re-arm.
    if (!meta?.workspaceId || !meta.nodeId) return;

    const row = await this.env.DB
      .prepare('SELECT status, last_heartbeat_at FROM nodes WHERE workspace_id = ? AND id = ? LIMIT 1')
      .bind(meta.workspaceId, meta.nodeId)
      .first<{ status: string; last_heartbeat_at: number | null }>();

    // Node row is gone (deregistered/deleted): stop the liveness alarm so a
    // dead node does not keep an isolate waking every 30s forever.
    if (!row) return;

    // Already offline: the next (re)connect re-arms the alarm in
    // handleWebSocketUpgrade, so there is nothing to do until then.
    if (row.status !== 'online') return;

    if (!row.last_heartbeat_at || Date.now() - row.last_heartbeat_at * 1000 > NODE_LIVENESS_TTL_MS) {
      // Heartbeats lapsed while still marked online: mark offline and stop
      // re-arming (the node is no longer live).
      await markNodeOffline(this.env, meta.workspaceId, meta.nodeId);
      return;
    }

    // Still live: keep sweeping for the next lapse.
    await this.state.storage.setAlarm(Date.now() + NODE_SWEEP_ALARM_MS);
  }

  private async getMeta(): Promise<NodeMeta | null> {
    if (this.meta) return this.meta;
    const meta = await this.state.storage.get<NodeMeta>('meta');
    this.meta = meta ?? null;
    return this.meta;
  }
}

export async function sendToNode(env: CloudflareBindings, workspaceId: string, nodeId: string, message: ToNodeMessage): Promise<boolean> {
  const stub = env.NODE_DO.get(env.NODE_DO.idFromName(`${workspaceId}:${nodeId}`));
  const response = await stub.fetch(new Request('http://do/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  }));
  const payload = (await response.json().catch(() => ({}))) as { delivered?: boolean };
  return payload.delivered === true;
}
