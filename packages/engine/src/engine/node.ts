import { and, asc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import type {
  FleetAgentRecoverMessage,
  FleetAgentRegisterMessage,
  FleetBrokerToRelaycastMessage,
  FleetCapabilityAcceptance,
  FleetInventoryAgent,
  FleetNodeHeartbeatMessage,
  FleetNodeRegisterMessage,
  FleetProviderIdentity,
  FleetCapability,
  AgentRegisterReplyData,
} from '@relaycast/types';
import {
  FLEET_DELIVERY_CURSOR_CAPABILITY,
  parseFleetBrokerToRelaycastMessage,
} from '@relaycast/types';
import type { getDb } from '../db/index.js';
import { actionInvocations, agents, agentNodeBindings, channelMembers, channels, nodeProviders, nodes } from '../db/schema.js';
import { randomHex, sha256Hex } from '../lib/crypto.js';
import { codedError } from '../lib/httpError.js';
import { runAtomic } from '../ports/database.js';
import type { EngineDb } from '../ports/database.js';
import { isProviderAgentDeliveryReady, type NodeConnectionRegistry } from '../ports/realtime.js';
import { generateId } from './snowflake.js';
import { assertRegistrableAgentName } from './agent.js';
import { rotateAgentIdentity } from './agentIdentity.js';
import { isNodeLive, nodeHasCapacity, nodeHasCapability } from './placement.js';
import {
  DEFAULT_PROVIDER_NAME,
  capabilityKind,
  heartbeatProvider,
  isProviderLive,
  markProviderOffline,
  materializeProviderActions,
  recomputeNodeAggregate,
  removeProvider,
  upsertProvider,
} from './nodeProvider.js';
import { serializeNodeOp } from './nodeLock.js';
import {
  completeNodeInvocation,
  dispatchCapacitySpawn,
  rescheduleInvocationsForLostNode,
  rescheduleNodeInvocation,
} from './action.js';
import { emitInvocationCompletionEffects, emitAgentExitedEffects, emitNodeStatusEffects, fleetInvocationId } from './invocationCompletion.js';
import type { InvocationCompletionDeps, NodeOfflineReason } from './invocationCompletion.js';
import { ackDeliveriesUpToSeq, deliverPendingToNode } from './delivery.js';

type Db = ReturnType<typeof getDb>;
type NodeRow = typeof nodes.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type NodeKind = 'ws' | 'http_push' | 'poll';
type NodeRole = 'direct' | 'broker';

/** Minimal socket surface used by node-control dispatchers to send reply frames. */
export interface NodeSocketLike {
  send(data: string): void;
}

export interface HandleNodeControlMessageArgs {
  db: EngineDb;
  registry: NodeConnectionRegistry;
  completionDeps?: InvocationCompletionDeps;
  workspaceId: string;
  nodeId: string;
  socket?: NodeSocketLike;
  /**
   * The registry connection this frame arrived on. Providers are bound to it at
   * `node.register`; later frames resolve their provider from it. Absent when a
   * caller drives node control without a registry-managed socket.
   */
  connectionId?: string;
  raw: string;
}

function resolveProviderIdentity(
  message: { provider?: FleetProviderIdentity },
  connectionId: string | undefined,
): FleetProviderIdentity {
  if (message.provider) return message.provider;
  return { name: DEFAULT_PROVIDER_NAME, instance_id: connectionId ?? generateId() };
}

type CapabilityLike = string | FleetCapability;

export function directNodeIdForAgent(agentId: string): string {
  return `node_direct_${agentId}`;
}

function directNodeNameForAgent(agentId: string): string {
  return `direct-${agentId}`;
}

function isImplicitDirectLocation(agent: Pick<AgentRow, 'id' | 'locationNodeId'>): boolean {
  return agent.locationNodeId === directNodeIdForAgent(agent.id);
}

function normalizeCapabilities(capabilities: CapabilityLike[]): FleetCapability[] {
  return capabilities.map((capability) => (
    typeof capability === 'string' ? { name: capability } : capability
  ));
}

const REPO_TAG_PREFIX = 'repo:';

function isRepoTag(tag: string): boolean {
  return tag.startsWith(REPO_TAG_PREFIX);
}

// Placement matches a node to an assignment by its `repo:<owner/name>` tag, so
// a node that can inject its own `repo:` tag can claim work for repositories it
// has no checkout of. Structured `repo_keys` is therefore the only source of
// repo advertisements: once a registration carries the field at all - even as an
// empty list - every caller-supplied `repo:` tag is dropped rather than merged.
// Registrations that omit the field entirely are pre-`repo_keys` clients and
// stay on the legacy tag-only path. Non-repo tags always round-trip.
function registrationTags(message: FleetNodeRegisterMessage): string[] {
  if (!message.repo_keys) return [...new Set(message.tags)];
  return [...new Set([
    ...message.tags.filter((tag) => !isRepoTag(tag)),
    ...message.repo_keys.map((repoKey) => `repo:${repoKey}`),
  ])];
}

function supportsProviderDeliveryReadiness(registry: NodeConnectionRegistry): boolean {
  return typeof registry.setProviderDeliveryReadiness === 'function'
    && typeof registry.markProviderAgentsDeliveryReady === 'function'
    && typeof registry.isProviderAgentDeliveryReady === 'function';
}

function requestId(message: { id?: string }): string {
  return message.id ?? generateId();
}

function publicNode(row: NodeRow) {
  const live = isNodeLive(row);
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    role: row.role,
    machine_id: row.machineId,
    delivery_adapter: row.deliveryAdapter,
    delivery: redactDeliveryConfig(row.deliveryConfig),
    capabilities: row.capabilities,
    tags: row.tags,
    version: row.version,
    status: live ? 'online' : 'offline',
    live,
    handlers_live: live && row.handlersLive,
    load: row.loadReported ? row.load : null,
    active_agents: row.activeAgents,
    max_agents: row.maxAgents,
    last_heartbeat_at: row.lastHeartbeatAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}

const SENSITIVE_DELIVERY_KEY = /api[_-]?key|authorization|cookie|credential|headers|password|private[_-]?key|secret|token/i;

function redactDeliveryValue(key: string | null, value: unknown): unknown {
  if (key && /^headers$/i.test(key) && value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).map((name) => [name, '[redacted]']));
  }
  if (key && SENSITIVE_DELIVERY_KEY.test(key)) {
    return '[redacted]';
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeliveryValue(null, item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        redactDeliveryValue(childKey, childValue),
      ]),
    );
  }
  return value;
}

function redactDeliveryConfig(config: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!config) return null;
  return redactDeliveryValue(null, config) as Record<string, unknown>;
}

function normalizeLegacyNodeShape(kind: string, role?: string | null): { kind: NodeKind; role: NodeRole } {
  if (kind === 'fleet_ws') return { kind: 'ws', role: 'broker' };
  if (kind === 'direct_ws') return { kind: 'ws', role: 'direct' };
  if (kind === 'http_push') return { kind: 'http_push', role: role === 'broker' ? 'broker' : 'direct' };
  if (kind === 'poll') return { kind: 'poll', role: role === 'broker' ? 'broker' : 'direct' };
  return { kind: 'ws', role: role === 'direct' ? 'direct' : 'broker' };
}

function defaultAdapter(kind: NodeKind, deliveryConfig?: Record<string, unknown> | null): string {
  if (kind === 'ws') return 'ws.node.v1';
  if (kind === 'poll') return 'poll.v1';
  const auth = deliveryConfig?.auth;
  const authType = auth && typeof auth === 'object' && !Array.isArray(auth)
    ? (auth as { type?: unknown }).type
    : undefined;
  if (authType === 'hmac_sha256') return 'http.hmac.v1';
  if (authType === 'bearer') return 'http.bearer.v1';
  if (authType === 'static_headers') return 'http.static_headers.v1';
  return 'http.basic.v1';
}

function normalizeLegacyAdapter(adapter: string | null | undefined): string | undefined {
  if (!adapter) return undefined;
  if (adapter === 'fleet.ws.v1' || adapter === 'direct.ws.v1') return 'ws.node.v1';
  return adapter;
}

export async function createNodeToken(
  db: Db,
  workspaceId: string,
  data: {
    node_id?: string;
    name: string;
    machine_id?: string;
    kind?: NodeKind;
    role?: NodeRole;
    delivery_adapter?: string;
    delivery?: Record<string, unknown> | null;
    capabilities?: CapabilityLike[];
    max_agents?: number;
    tags?: string[];
    version?: string;
  },
) {
  const token = `nt_live_${randomHex(24)}`;
  const tokenHash = await sha256Hex(token);
  const name = data.name.startsWith('#') ? data.name.slice(1) : data.name;
  // Reject names that are empty or still #-prefixed after normalization: an
  // empty name is unreachable via /v1/nodes/:name, and a residual "#" would
  // dodge every name lookup (including the conflict check below).
  if (!name || name.startsWith('#')) {
    throw codedError('Node name must be non-empty and cannot begin with "#"', 'invalid_node_name', 400);
  }
  // Enrollment keys on node_id (the stable identity) when supplied; the name
  // lookup is only a fallback for callers without a stable id. A name held by
  // a *different* node id is a conflict — mirroring node.register — never a
  // silent rewrite of the other node.
  const existing = await resolveNodeForEnroll(db, workspaceId, data);
  if (data.node_id !== undefined) {
    const nameHolder = await getNodeByName(db, workspaceId, name);
    if (nameHolder && nameHolder.id !== data.node_id) {
      throw codedError(`Node name "${name}" is already enrolled by another node`, 'node_name_conflict', 409);
    }
  }
  const now = new Date();
  const existingShape = existing ? normalizeLegacyNodeShape(existing.kind, existing.role) : null;
  const normalized = normalizeLegacyNodeShape(
    data.kind ?? existing?.kind ?? 'ws',
    data.role ?? existing?.role ?? (data.max_agents !== undefined && data.max_agents > 1 ? 'broker' : undefined),
  );
  const kind = normalized.kind;
  const role = normalized.role;
  // When the node shape (transport or role) changes on update, recompute the
  // delivery adapter and capacity instead of reusing the stale values: rotating
  // an http_push node to ws must not keep an http.* adapter, and switching a
  // broker to direct must not retain a capacity > 1.
  const shapeChanged = !!existingShape && (existingShape.kind !== kind || existingShape.role !== role);
  const deliveryConfig = data.delivery === undefined ? existing?.deliveryConfig ?? null : data.delivery;
  const deliveryAdapter = data.delivery_adapter
    ?? (!shapeChanged && data.delivery === undefined ? normalizeLegacyAdapter(existing?.deliveryAdapter) : undefined)
    ?? defaultAdapter(kind, deliveryConfig);
  const maxAgents = role === 'direct'
    ? (data.max_agents ?? 1)
    : (data.max_agents ?? existing?.maxAgents ?? 0);
  if (role === 'direct' && maxAgents !== 1) {
    throw codedError('Direct nodes can bind at most one agent', 'direct_node_capacity_exceeded', 400);
  }

  if (existing) {
    const [updated] = await db
      .update(nodes)
      .set({
        name,
        tokenHash,
        kind,
        role,
        deliveryAdapter,
        deliveryConfig,
        capabilities: normalizeCapabilities(data.capabilities ?? existing.capabilities),
        machineId: data.machine_id ?? existing.machineId,
        maxAgents,
        tags: data.tags ?? existing.tags,
        version: data.version ?? existing.version,
        status: 'offline',
        handlersLive: false,
        load: 0,
        loadReported: false,
      })
      .where(eq(nodes.id, existing.id))
      .returning();
    return { ...publicNode(updated), token };
  }

  const [created] = await db
    .insert(nodes)
    .values({
      id: data.node_id ?? `node_${generateId()}`,
      workspaceId,
      name,
      tokenHash,
      kind,
      role,
      deliveryAdapter,
      deliveryConfig,
      capabilities: normalizeCapabilities(data.capabilities ?? []),
      machineId: data.machine_id ?? null,
      maxAgents,
      tags: data.tags ?? [],
      version: data.version ?? 'unknown',
      status: 'offline',
      handlersLive: false,
      load: 0,
      loadReported: false,
      activeAgents: 0,
      createdAt: now,
    })
    .returning();
  return { ...publicNode(created), token };
}

export async function getNodeByTokenHash(db: Db, tokenHash: string) {
  const [node] = await db.select().from(nodes).where(eq(nodes.tokenHash, tokenHash));
  return node ?? null;
}

export async function getNodeByName(db: Db, workspaceId: string, name: string) {
  const normalized = name.startsWith('#') ? name.slice(1) : name;
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.name, normalized)));
  return node ?? null;
}

export async function getNodeById(db: Db, workspaceId: string, nodeId: string) {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)));
  return node ?? null;
}

/**
 * The broker a machine already has on the roster, if any.
 *
 * Scoped to `broker` deliberately: a broker is the node-of-many fleet host and
 * a machine runs one, so machine_id identifies it. A `direct` node is a
 * node-of-one delivery host and a single machine legitimately runs many of
 * them, so machine_id is not a key there and must never collapse them.
 *
 * Ordered oldest-first so a roster that already holds several rows for one
 * machine converges onto its earliest row instead of picking arbitrarily.
 */
export async function getBrokerNodeByMachineId(db: Db, workspaceId: string, machineId: string) {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(
      eq(nodes.workspaceId, workspaceId),
      eq(nodes.machineId, machineId),
      eq(nodes.role, 'broker'),
    ))
    .orderBy(asc(nodes.createdAt), asc(nodes.id))
    .limit(1);
  return node ?? null;
}

/**
 * The role an enroll is asking for, derived from the request alone.
 *
 * Enrollment's role default depends on `kind` (`ws` is a broker; `http_push`
 * and `poll` are direct) and on `max_agents`, and the machine lookup has to
 * know it *before* it runs. Otherwise a machine that already has a broker has
 * that broker rotated -- and its transport rewritten to http_push or poll --
 * by a node enrolling alongside it without an explicit `role`. That failure
 * would be silent and would move a live node's identity, which is worse than
 * the roster growth this dedupe exists to stop.
 */
export function requestedNodeRole(data: { kind?: string; role?: NodeRole; max_agents?: number }): NodeRole {
  if (data.role) return data.role;
  return normalizeLegacyNodeShape(
    data.kind ?? 'ws',
    data.max_agents !== undefined && data.max_agents > 1 ? 'broker' : undefined,
  ).role;
}

/**
 * Resolve the node an enroll (POST /v1/nodes) targets: by node_id when
 * supplied, then by name, then by machine_id.
 *
 * The machine_id step is what stops the roster refilling. A host that enrolls
 * without a persisted node_id arrives under a fresh name on every boot, and
 * each of those names used to mint a brand-new row that nothing ever reclaimed.
 * Falling back to the machine's existing broker turns re-enrollment into a
 * token rotation on the row that is already there.
 *
 * node_id and name still win, so a caller that pins either keeps the exact
 * identity it asked for; passing node_id is the way to opt out of machine
 * grouping and run two brokers on one host.
 */
export async function resolveNodeForEnroll(
  db: Db,
  workspaceId: string,
  data: { node_id?: string; name: string; machine_id?: string; kind?: string; role?: NodeRole; max_agents?: number },
) {
  if (data.node_id !== undefined) {
    return getNodeById(db, workspaceId, data.node_id);
  }
  const byName = await getNodeByName(db, workspaceId, data.name);
  if (byName) return byName;
  if (data.machine_id !== undefined && requestedNodeRole(data) === 'broker') {
    return getBrokerNodeByMachineId(db, workspaceId, data.machine_id);
  }
  return null;
}

export interface RegisterNodeResult {
  node: ReturnType<typeof publicNode>;
  acceptance: FleetCapabilityAcceptance[];
  provider: FleetProviderIdentity;
}

export async function registerNode(
  db: Db,
  workspaceId: string,
  authenticatedNodeId: string,
  message: FleetNodeRegisterMessage,
  provider: FleetProviderIdentity,
): Promise<RegisterNodeResult> {
  if (message.node_id !== authenticatedNodeId) {
    throw codedError('node_id does not match the authenticated node token', 'node_id_mismatch', 403);
  }

  const now = new Date();
  const [existing] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, authenticatedNodeId)));
  if (!existing) {
    throw codedError('Node token is not enrolled in this workspace', 'node_not_found', 404);
  }

  const tags = registrationTags(message);

  const [existingByName] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.name, message.name)));

  if (existingByName && existingByName.id !== authenticatedNodeId) {
    throw codedError(`Node name "${message.name}" is already enrolled`, 'node_name_conflict', 409);
  }

  // Direct nodes are the per-agent delivery hosts: they never carry providers.
  if (existing.role === 'direct') {
    // Direct-node registration historically preserved enrollment tags. Keep
    // those non-repo tags while refreshing only the node's repo advertisement.
    const directTags = [...new Set([
      ...existing.tags.filter((tag) => !isRepoTag(tag)),
      ...tags,
    ])];
    const [updated] = await db
      .update(nodes)
      .set({
        name: message.name,
        capabilities: [],
        kind: 'ws',
        role: 'direct',
        deliveryAdapter: 'ws.node.v1',
        deliveryConfig: existing.deliveryConfig,
        maxAgents: 1,
        activeAgents: 1,
        tags: directTags,
        version: message.version,
        status: 'online',
        handlersLive: false,
        load: 0,
        loadReported: false,
        lastHeartbeatAt: now,
      })
      .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, authenticatedNodeId)))
      .returning();
    return { node: publicNode(updated), acceptance: [], provider };
  }

  const capabilities = normalizeCapabilities(message.capabilities);
  await runAtomic(db, async (tx) => {
    await upsertProvider(tx, workspaceId, authenticatedNodeId, {
      name: provider.name,
      instanceId: provider.instance_id,
      capabilities,
      maxAgents: message.max_agents,
      version: message.version,
      handlersLive: capabilities.length > 0,
    });
    await materializeProviderActions(tx, workspaceId, authenticatedNodeId, provider.name, capabilities);
    await tx
      .update(nodes)
      .set({ name: message.name, kind: 'ws', role: 'broker', deliveryAdapter: 'ws.node.v1', deliveryConfig: null, tags })
      .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, authenticatedNodeId)));
    await recomputeNodeAggregate(tx, workspaceId, authenticatedNodeId, {
      version: message.version,
      machineId: message.machine_id ?? null,
    });
  });

  const [updated] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, authenticatedNodeId)));
  const acceptance: FleetCapabilityAcceptance[] = capabilities.map((cap) => ({
    name: cap.name,
    kind: capabilityKind(cap),
    accepted: true,
  }));
  return { node: publicNode(updated), acceptance, provider };
}

export async function heartbeatNode(
  db: Db,
  workspaceId: string,
  nodeId: string,
  providerName: string,
  message: FleetNodeHeartbeatMessage,
) {
  // A heartbeat is provider-scoped by connection. It may carry the provider's
  // roster snapshot so the engine can refresh the descriptor between (or in the
  // absence of a fresh) node.register — e.g. after an engine restart where the
  // provider keeps heartbeating. lastHeartbeatAt is always stamped server-side
  // as the authoritative receipt time; the client never sends it.
  if (message.node_id !== undefined && message.node_id !== nodeId) {
    throw codedError('node_id does not match the authenticated node token', 'node_id_mismatch', 403);
  }

  const [nodeState] = await db
    .select({ role: nodes.role })
    .from(nodes)
    .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)));
  if (!nodeState) return null;

  if (nodeState.role === 'direct') {
    const rosterUpdate: Partial<typeof nodes.$inferInsert> = {};
    if (message.name !== undefined) rosterUpdate.name = message.name;
    if (message.version !== undefined) rosterUpdate.version = message.version;
    const [updated] = await db
      .update(nodes)
      .set({
        ...rosterUpdate,
        status: 'online',
        load: message.load_reported === true && typeof message.load === 'number' ? message.load : 0,
        loadReported: message.load_reported === true && typeof message.load === 'number',
        activeAgents: 1,
        handlersLive: false,
        lastHeartbeatAt: new Date(),
      })
      .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)))
      .returning();
    return updated ? publicNode(updated) : null;
  }

  await runAtomic(db, async (tx) => {
    if (message.capabilities !== undefined) {
      const caps = normalizeCapabilities(message.capabilities);
      const [existingProvider] = await tx
        .select({ instanceId: nodeProviders.instanceId, maxAgents: nodeProviders.maxAgents, version: nodeProviders.version })
        .from(nodeProviders)
        .where(and(
          eq(nodeProviders.workspaceId, workspaceId),
          eq(nodeProviders.nodeId, nodeId),
          eq(nodeProviders.name, providerName),
        ));
      await upsertProvider(tx, workspaceId, nodeId, {
        name: providerName,
        instanceId: existingProvider?.instanceId ?? `${providerName}:heartbeat`,
        capabilities: caps,
        maxAgents: message.max_agents ?? existingProvider?.maxAgents ?? 0,
        version: message.version ?? existingProvider?.version ?? 'unknown',
        handlersLive: message.handlers_live,
      });
      await heartbeatProvider(tx, workspaceId, nodeId, providerName, {
        load: message.load,
        loadReported: message.load_reported,
        activeAgents: message.active_agents,
        handlersLive: message.handlers_live,
      });
      await materializeProviderActions(tx, workspaceId, nodeId, providerName, caps);
    } else {
      await heartbeatProvider(tx, workspaceId, nodeId, providerName, {
        load: message.load,
        loadReported: message.load_reported,
        activeAgents: message.active_agents,
        handlersLive: message.handlers_live,
      });
    }
    if (message.name !== undefined) {
      await tx.update(nodes).set({ name: message.name }).where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)));
    }
    await recomputeNodeAggregate(tx, workspaceId, nodeId, message.version !== undefined ? { version: message.version } : {});
  });

  const [updated] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)));
  return updated ? publicNode(updated) : null;
}

export async function markNodeOffline(
  db: Db,
  registry: NodeConnectionRegistry,
  workspaceId: string,
  nodeId: string,
  effects?: { deps?: InvocationCompletionDeps; reason?: NodeOfflineReason },
) {
  // Capture the node's name + prior status BEFORE flipping it so a durable
  // node.status.offline is emitted only on a real online -> offline transition
  // (never on a node that was already offline).
  const [before] = await db
    .select({ status: nodes.status, name: nodes.name })
    .from(nodes)
    .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)));

  await db
    .update(nodes)
    .set({
      status: 'offline',
      handlersLive: false,
      load: 0,
      loadReported: false,
      activeAgents: 0,
      lastHeartbeatAt: new Date(),
    })
    .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)));

  // Provider capability sets persist (offline nodes still show their manifest);
  // only their liveness flips. Zero activeAgents too, so a later
  // recomputeNodeAggregate never resurrects a dropped provider's agent count.
  await db
    .update(nodeProviders)
    .set({ status: 'offline', handlersLive: false, load: 0, loadReported: false, activeAgents: 0, lastHeartbeatAt: new Date() })
    .where(and(eq(nodeProviders.workspaceId, workspaceId), eq(nodeProviders.nodeId, nodeId)));

  await db
    .update(agents)
    .set({ status: 'offline', lastSeen: new Date() })
    .where(and(
      eq(agents.workspaceId, workspaceId),
      eq(agents.locationType, 'via_node'),
      eq(agents.locationNodeId, nodeId),
    ));

  await rescheduleInvocationsForLostNode(db, registry, workspaceId, nodeId);

  if (effects?.deps && before && before.status === 'online') {
    await emitNodeStatusEffects(effects.deps, workspaceId, {
      status: 'offline',
      nodeId,
      nodeName: before.name,
      reason: effects.reason,
    });
  }
}

/**
 * A provider's control connection dropped. Its capability set persists (marked
 * offline) so the node still shows the manifest; agents it hosted go offline.
 * When it was the node's last connection the whole node goes offline.
 */
export async function handleProviderDisconnect(
  db: Db,
  registry: NodeConnectionRegistry,
  workspaceId: string,
  nodeId: string,
  providerName: string,
  hasRemainingConnections: boolean,
  deps?: InvocationCompletionDeps,
) {
  // Serialized with node-control operations so a teardown can't race a
  // concurrent register's provider upsert / aggregate recompute (or, on
  // better-sqlite3, deadlock its isolated transaction).
  return serializeNodeOp(workspaceId, nodeId, async () => {
    if (!hasRemainingConnections) {
      await markNodeOffline(db, registry, workspaceId, nodeId, { deps, reason: 'disconnected' });
      return;
    }
    await markProviderOffline(db, workspaceId, nodeId, providerName);
    await db
      .update(agents)
      .set({ status: 'offline', lastSeen: new Date() })
      .where(and(
        eq(agents.workspaceId, workspaceId),
        eq(agents.locationType, 'via_node'),
        eq(agents.locationNodeId, nodeId),
        eq(agents.providerName, providerName),
      ));
    await recomputeNodeAggregate(db, workspaceId, nodeId);
  });
}

/**
 * Provider-scoped deregister: removes the provider's attachment, persisted
 * capability set, and materialized actions. When it was the node's last
 * provider the node goes fully offline.
 */
export async function deregisterProvider(
  db: Db,
  registry: NodeConnectionRegistry,
  workspaceId: string,
  nodeId: string,
  providerName: string,
  deps?: InvocationCompletionDeps,
) {
  await removeProvider(db, workspaceId, nodeId, providerName);
  registry.detachProvider(workspaceId, nodeId, providerName);
  await db
    .update(agents)
    .set({ status: 'offline', lastSeen: new Date() })
    .where(and(
      eq(agents.workspaceId, workspaceId),
      eq(agents.locationType, 'via_node'),
      eq(agents.locationNodeId, nodeId),
      eq(agents.providerName, providerName),
    ));
  const [remaining] = await db
    .select({ count: sql<number>`count(*)` })
    .from(nodeProviders)
    .where(and(eq(nodeProviders.workspaceId, workspaceId), eq(nodeProviders.nodeId, nodeId)));
  if (!remaining || remaining.count === 0) {
    await markNodeOffline(db, registry, workspaceId, nodeId, { deps, reason: 'deregistered' });
  } else {
    // Other provider rows remain (possibly all offline): recompute the node
    // aggregate but don't reschedule node-wide — that would disturb the surviving
    // providers' in-flight invokes. Work dispatched to the removed provider is
    // caught by the dispatch-timeout sweep, matching the provider-disconnect path.
    // Capture status across the recompute so that when the deregistered provider
    // was the node's last *online* one, the resulting online -> offline flip still
    // emits a durable node.status.offline — recomputeNodeAggregate flips the
    // column but never emits.
    const [before] = await db
      .select({ status: nodes.status, name: nodes.name })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)));
    await recomputeNodeAggregate(db, workspaceId, nodeId);
    if (deps && before?.status === 'online') {
      const [after] = await db
        .select({ status: nodes.status, name: nodes.name })
        .from(nodes)
        .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)));
      if (after && after.status !== 'online') {
        await emitNodeStatusEffects(deps, workspaceId, {
          status: 'offline',
          nodeId,
          nodeName: after.name ?? before.name,
          reason: 'deregistered',
        });
      }
    }
  }
}

export async function sweepOfflineNodes(
  db: Db,
  registry: NodeConnectionRegistry,
  deps?: InvocationCompletionDeps,
): Promise<number> {
  const rows = await db.select().from(nodes).where(eq(nodes.status, 'online'));
  const stale = rows.filter((node) => !isNodeLive(node));
  let swept = 0;
  for (const node of stale) {
    const offlined = await serializeNodeOp(node.workspaceId, node.id, async () => {
      // Re-read under the lock: a heartbeat/register queued ahead of this sweep
      // may have refreshed the node since the stale snapshot was taken.
      const [current] = await db
        .select()
        .from(nodes)
        .where(and(eq(nodes.workspaceId, node.workspaceId), eq(nodes.id, node.id)));
      if (!current || current.status !== 'online' || isNodeLive(current)) return false;
      await markNodeOffline(db, registry, node.workspaceId, node.id, { deps, reason: 'liveness_timeout' });
      return true;
    });
    if (offlined) swept++;
  }
  return swept;
}

async function autoJoinGeneral(db: Db, workspaceId: string, agentId: string) {
  const [generalChannel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.workspaceId, workspaceId), eq(channels.name, 'general')));
  if (generalChannel) {
    await db.insert(channelMembers).values({
      channelId: generalChannel.id,
      agentId,
      role: 'member',
    }).onConflictDoNothing();
  }
}

async function upsertAgentNodeBinding(
  db: Db,
  workspaceId: string,
  agent: Pick<AgentRow, 'id' | 'locationNodeId'>,
  nodeId: string,
  opts: { sessionRef?: string | null; priority?: number; deactivateExisting?: boolean } = {},
) {
  if (opts.deactivateExisting ?? true) {
    await db
      .update(agentNodeBindings)
      .set({ status: 'inactive', updatedAt: new Date() })
      .where(and(
        eq(agentNodeBindings.workspaceId, workspaceId),
        eq(agentNodeBindings.agentId, agent.id),
        eq(agentNodeBindings.status, 'active'),
        ne(agentNodeBindings.nodeId, nodeId),
      ));
  }

  await db
    .insert(agentNodeBindings)
    .values({
      id: `anb_${generateId()}`,
      workspaceId,
      agentId: agent.id,
      nodeId,
      status: 'active',
      sessionRef: opts.sessionRef ?? null,
      priority: opts.priority ?? 0,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [agentNodeBindings.agentId, agentNodeBindings.nodeId],
      set: {
        status: 'active',
        sessionRef: opts.sessionRef ?? null,
        priority: opts.priority ?? 0,
        updatedAt: new Date(),
      },
    });

  await db
    .update(agents)
    .set({
      locationType: 'via_node',
      locationNodeId: nodeId,
      sessionRef: opts.sessionRef ?? undefined,
      status: 'active',
      lastSeen: new Date(),
    })
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agent.id)));
}

async function activeBindingNodeIdsForAgent(db: Db, workspaceId: string, agentId: string): Promise<string[]> {
  const rows = await db
    .select({ nodeId: agentNodeBindings.nodeId })
    .from(agentNodeBindings)
    .where(and(
      eq(agentNodeBindings.workspaceId, workspaceId),
      eq(agentNodeBindings.agentId, agentId),
      eq(agentNodeBindings.status, 'active'),
    ));
  return rows.map((row) => row.nodeId);
}

async function reserveNodeAgentSlot(db: Db, workspaceId: string, node: NodeRow): Promise<void> {
  const [reserved] = await db
    .update(nodes)
    .set({
      activeAgents: sql`${nodes.activeAgents} + 1`,
    })
    .where(and(
      eq(nodes.workspaceId, workspaceId),
      eq(nodes.id, node.id),
      or(eq(nodes.maxAgents, 0), sql`${nodes.activeAgents} < ${nodes.maxAgents}`),
    ))
    .returning({ id: nodes.id });
  if (!reserved) {
    throw codedError(`Node "${node.name}" is at capacity`, 'node_capacity_exceeded', 409);
  }
}

async function releaseNodeAgentSlots(db: Db, workspaceId: string, nodeIds: string[]): Promise<void> {
  const uniqueNodeIds = [...new Set(nodeIds)];
  if (uniqueNodeIds.length === 0) return;
  await db
    .update(nodes)
    .set({
      activeAgents: sql`CASE WHEN ${nodes.activeAgents} > 0 THEN ${nodes.activeAgents} - 1 ELSE 0 END`,
    })
    .where(and(
      eq(nodes.workspaceId, workspaceId),
      inArray(nodes.id, uniqueNodeIds),
    ));
}

export async function ensureDirectNodeForAgent(
  db: Db,
  workspaceId: string,
  agent: Pick<AgentRow, 'id' | 'name' | 'locationNodeId'>,
  opts: { force?: boolean; online?: boolean; sessionRef?: string | null } = {},
) {
  return runAtomic(db, (tx) => ensureDirectNodeForAgentInTx(tx, workspaceId, agent, opts));
}

async function ensureDirectNodeForAgentInTx(
  db: Db,
  workspaceId: string,
  agent: Pick<AgentRow, 'id' | 'name' | 'locationNodeId'>,
  opts: { force?: boolean; online?: boolean; sessionRef?: string | null } = {},
) {
  const activeNodeIds = await activeBindingNodeIdsForAgent(db, workspaceId, agent.id);
  const nodeId = directNodeIdForAgent(agent.id);
  const alreadyDirect = activeNodeIds.includes(nodeId);
  const explicitNodeIds = activeNodeIds.filter((activeNodeId) => activeNodeId !== nodeId);
  if (!opts.force && explicitNodeIds.length > 0) {
    return null;
  }

  const now = new Date();
  const [existingDirect] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)));

  if (!opts.force && alreadyDirect && existingDirect && agent.locationNodeId === nodeId) {
    const update: Partial<typeof nodes.$inferInsert> = {
      name: directNodeNameForAgent(agent.id),
      kind: 'ws',
      role: 'direct',
      deliveryAdapter: 'ws.node.v1',
      deliveryConfig: {
        implicit: true,
        agent_id: agent.id,
        agent_name: agent.name,
      },
      capabilities: [],
      maxAgents: 1,
      activeAgents: 1,
      tags: ['implicit', 'direct'],
      version: 'implicit',
      handlersLive: false,
      load: 0,
      loadReported: false,
    };
    if (opts.online) {
      update.status = 'online';
      update.lastHeartbeatAt = now;
    }
    const [updatedDirect] = await db
      .update(nodes)
      .set(update)
      .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)))
      .returning();
    return publicNode(updatedDirect ?? {
      ...existingDirect,
      ...update,
      activeAgents: 1,
      status: opts.online ? 'online' : existingDirect.status,
      lastHeartbeatAt: opts.online ? now : existingDirect.lastHeartbeatAt,
    });
  }

  let directNode = existingDirect;
  if (!directNode) {
    const tokenHash = await sha256Hex(`implicit_direct:${workspaceId}:${agent.id}:${randomHex(16)}`);
    [directNode] = await db
      .insert(nodes)
      .values({
        id: nodeId,
        workspaceId,
        name: directNodeNameForAgent(agent.id),
        tokenHash,
        kind: 'ws',
        role: 'direct',
        deliveryAdapter: 'ws.node.v1',
        deliveryConfig: {
          implicit: true,
          agent_id: agent.id,
          agent_name: agent.name,
        },
        capabilities: [],
        maxAgents: 1,
        activeAgents: 0,
        tags: ['implicit', 'direct'],
        version: 'implicit',
        status: opts.online ? 'online' : 'offline',
        handlersLive: false,
        load: 0,
        loadReported: false,
        lastHeartbeatAt: opts.online ? now : null,
        createdAt: now,
      })
      .returning();
  } else {
    const update: Partial<typeof nodes.$inferInsert> = {
      name: directNodeNameForAgent(agent.id),
      kind: 'ws',
      role: 'direct',
      deliveryAdapter: 'ws.node.v1',
      deliveryConfig: {
        implicit: true,
        agent_id: agent.id,
        agent_name: agent.name,
      },
      capabilities: [],
      maxAgents: 1,
      tags: ['implicit', 'direct'],
      version: 'implicit',
      handlersLive: false,
      load: 0,
      loadReported: false,
    };
    if (opts.online) {
      update.status = 'online';
      update.lastHeartbeatAt = now;
    }
    [directNode] = await db
      .update(nodes)
      .set(update)
      .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)))
      .returning();
  }

  await upsertAgentNodeBinding(db, workspaceId, agent, nodeId, {
    sessionRef: opts.sessionRef ?? null,
    deactivateExisting: true,
  });
  await releaseNodeAgentSlots(db, workspaceId, explicitNodeIds);
  await db
    .update(nodes)
    .set({
      activeAgents: 1,
      status: opts.online ? 'online' : directNode.status,
      lastHeartbeatAt: opts.online ? now : directNode.lastHeartbeatAt,
    })
    .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)));

  return publicNode({
    ...directNode,
    activeAgents: 1,
    status: opts.online ? 'online' : directNode.status,
    lastHeartbeatAt: opts.online ? now : directNode.lastHeartbeatAt,
  });
}

export async function markDirectNodeOfflineForAgent(
  db: Db,
  workspaceId: string,
  agentId: string,
) {
  const nodeId = directNodeIdForAgent(agentId);
  await db
    .update(nodes)
    .set({
      status: 'offline',
      handlersLive: false,
      load: 0,
      loadReported: false,
      lastHeartbeatAt: new Date(),
    })
    .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)));
}

function serializeBinding(row: {
  id: string;
  agentId: string;
  agentName: string;
  nodeId: string;
  nodeName: string;
  nodeKind: string;
  nodeRole: string;
  status: string;
  sessionRef: string | null;
  priority: number;
  createdAt: Date;
  updatedAt: Date | null;
}) {
  return {
    id: row.id,
    agent_id: row.agentId,
    agent_name: row.agentName,
    node_id: row.nodeId,
    node_name: row.nodeName,
    node_kind: row.nodeKind,
    node_role: row.nodeRole,
    status: row.status,
    session_ref: row.sessionRef,
    priority: row.priority,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt?.toISOString() ?? null,
  };
}

export async function bindAgentToNode(
  db: Db,
  workspaceId: string,
  nodeName: string,
  agentName: string,
  opts: { session_ref?: string | null; priority?: number } = {},
) {
  return runAtomic(db, async (tx) => {
    const node = await getNodeByName(tx, workspaceId, nodeName);
    if (!node) throw codedError(`Node "${nodeName}" not found`, 'node_not_found', 404);

    const [agent] = await tx
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, agentName)));
    if (!agent) throw codedError(`Agent "${agentName}" not found`, 'agent_not_found', 404);

    const activeNodeIds = await activeBindingNodeIdsForAgent(tx, workspaceId, agent.id);
    const targetWasActive = activeNodeIds.includes(node.id);
    let reservedTargetSlot = false;
    try {
      if (!targetWasActive) {
        await reserveNodeAgentSlot(tx, workspaceId, node);
        reservedTargetSlot = true;
      }
      await upsertAgentNodeBinding(tx, workspaceId, agent, node.id, {
        sessionRef: opts.session_ref ?? null,
        priority: opts.priority ?? 0,
      });
      await releaseNodeAgentSlots(tx, workspaceId, activeNodeIds.filter((nodeId) => nodeId !== node.id));
    } catch (err) {
      if (reservedTargetSlot) {
        await releaseNodeAgentSlots(tx, workspaceId, [node.id]);
      }
      throw err;
    }

    const [binding] = await tx
      .select({
        id: agentNodeBindings.id,
        agentId: agentNodeBindings.agentId,
        agentName: agents.name,
        nodeId: agentNodeBindings.nodeId,
        nodeName: nodes.name,
        nodeKind: nodes.kind,
        nodeRole: nodes.role,
        status: agentNodeBindings.status,
        sessionRef: agentNodeBindings.sessionRef,
        priority: agentNodeBindings.priority,
        createdAt: agentNodeBindings.createdAt,
        updatedAt: agentNodeBindings.updatedAt,
      })
      .from(agentNodeBindings)
      .innerJoin(agents, eq(agentNodeBindings.agentId, agents.id))
      .innerJoin(nodes, eq(agentNodeBindings.nodeId, nodes.id))
      .where(and(
        eq(agentNodeBindings.workspaceId, workspaceId),
        eq(agentNodeBindings.agentId, agent.id),
        eq(agentNodeBindings.nodeId, node.id),
      ));

    return serializeBinding(binding);
  });
}

export async function unbindAgentFromNode(db: Db, workspaceId: string, nodeName: string, agentName: string) {
  return runAtomic(db, async (tx) => {
    const node = await getNodeByName(tx, workspaceId, nodeName);
    if (!node) return false;
    const [agent] = await tx
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, agentName)));
    if (!agent) return false;

    const updated = await tx
      .update(agentNodeBindings)
      .set({ status: 'inactive', updatedAt: new Date() })
      .where(and(
        eq(agentNodeBindings.workspaceId, workspaceId),
        eq(agentNodeBindings.nodeId, node.id),
        eq(agentNodeBindings.agentId, agent.id),
        eq(agentNodeBindings.status, 'active'),
      ))
      .returning({ id: agentNodeBindings.id });

    if (updated.length === 0) return false;
    await releaseNodeAgentSlots(tx, workspaceId, [node.id]);

    if (agent.locationNodeId === node.id) {
      await ensureDirectNodeForAgentInTx(tx, workspaceId, agent, { force: true });
    }
    return true;
  });
}

export async function listNodeAgents(db: Db, workspaceId: string, nodeName: string) {
  const node = await getNodeByName(db, workspaceId, nodeName);
  if (!node) return null;
  const rows = await db
    .select({
      id: agentNodeBindings.id,
      agentId: agentNodeBindings.agentId,
      agentName: agents.name,
      nodeId: agentNodeBindings.nodeId,
      nodeName: nodes.name,
      nodeKind: nodes.kind,
      nodeRole: nodes.role,
      status: agentNodeBindings.status,
      sessionRef: agentNodeBindings.sessionRef,
      priority: agentNodeBindings.priority,
      createdAt: agentNodeBindings.createdAt,
      updatedAt: agentNodeBindings.updatedAt,
    })
    .from(agentNodeBindings)
    .innerJoin(agents, eq(agentNodeBindings.agentId, agents.id))
    .innerJoin(nodes, eq(agentNodeBindings.nodeId, nodes.id))
    .where(and(
      eq(agentNodeBindings.workspaceId, workspaceId),
      eq(agentNodeBindings.nodeId, node.id),
      eq(agentNodeBindings.status, 'active'),
    ));
  return rows.map(serializeBinding);
}

export async function registerAgentViaNode(
  db: Db,
  workspaceId: string,
  nodeId: string,
  providerName: string,
  message: FleetAgentRegisterMessage,
  options: { deliveryCursorSupported?: boolean } = {},
): Promise<AgentRegisterReplyData> {
  assertRegistrableAgentName(message.name);
  return runAtomic(db, async (tx) => {
    const [node] = await tx
      .select()
      .from(nodes)
      .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)));
    if (!node) throw codedError(`Node "${nodeId}" not found`, 'node_not_found', 404);
    const [provider] = await tx
      .select({ capabilities: nodeProviders.capabilities })
      .from(nodeProviders)
      .where(and(
        eq(nodeProviders.workspaceId, workspaceId),
        eq(nodeProviders.nodeId, nodeId),
        eq(nodeProviders.name, providerName),
      ));
    const cursorHandshake = (options.deliveryCursorSupported ?? true) && (provider?.capabilities?.some(
      (capability) => capability.name === FLEET_DELIVERY_CURSOR_CAPABILITY,
    ) ?? false);

    const token = `at_live_${randomHex(16)}`;
    const tokenHash = await sha256Hex(token);
    const now = new Date().toISOString();
    const [result] = await tx
      .insert(agents)
      .values({
        id: generateId(),
        workspaceId,
        name: message.name,
        handle: `@${message.name}`,
        type: 'agent',
        tokenHash,
        status: 'active',
        persona: null,
        metadata: { fleet: { node_id: nodeId, invocation_id: message.invocation_id ?? null, registered_at: now } },
        locationType: 'via_node',
        locationNodeId: nodeId,
        providerName,
        originNodeId: nodeId,
        resumable: message.resumable ?? false,
        sessionRef: message.session_ref ?? null,
      })
      .onConflictDoNothing({ target: [agents.workspaceId, agents.name] })
      .returning();

    if (!result) {
      throw codedError(
        `Agent "${message.name}" already exists; use agent.recover with proof of the immutable id`,
        'agent_already_exists',
        409,
      );
    }

    await autoJoinGeneral(tx, workspaceId, result.id);
    const activeNodeIds = await activeBindingNodeIdsForAgent(tx, workspaceId, result.id);
    const targetWasActive = activeNodeIds.includes(nodeId);
    let reservedTargetSlot = false;
    try {
      if (!targetWasActive) {
        await reserveNodeAgentSlot(tx, workspaceId, node);
        reservedTargetSlot = true;
      }
      await upsertAgentNodeBinding(tx, workspaceId, result, nodeId, {
        sessionRef: message.session_ref ?? null,
        deactivateExisting: true,
      });
      await releaseNodeAgentSlots(tx, workspaceId, activeNodeIds.filter((activeNodeId) => activeNodeId !== nodeId));
    } catch (err) {
      if (reservedTargetSlot) {
        await releaseNodeAgentSlots(tx, workspaceId, [nodeId]);
      }
      throw err;
    }
    return {
      agent_id: result.id,
      name: result.name,
      token,
      ...(cursorHandshake ? { delivery_ack_seq: result.deliveryAckSeq } : {}),
    };
  });
}

/**
 * Recover an existing agent using the authenticated node as the authority.
 * The immutable id and server-owned `origin_node_id` must both match; name,
 * presence, silence, and the synthetic direct-node convention grant nothing.
 */
export async function recoverAgentViaNode(
  db: Db,
  workspaceId: string,
  nodeId: string,
  providerName: string,
  message: FleetAgentRecoverMessage,
  options: { deliveryCursorSupported?: boolean } = {},
): Promise<AgentRegisterReplyData> {
  assertRegistrableAgentName(message.name);
  const hasInteractiveTransaction = typeof (db as EngineDb & {
    withTransaction?: unknown;
  }).withTransaction === 'function';
  return runAtomic(db, async (tx) => {
    const [node] = await tx
      .select()
      .from(nodes)
      .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)));
    if (!node) throw codedError(`Node "${nodeId}" not found`, 'node_not_found', 404);

    const [provider] = await tx
      .select({ capabilities: nodeProviders.capabilities })
      .from(nodeProviders)
      .where(and(
        eq(nodeProviders.workspaceId, workspaceId),
        eq(nodeProviders.nodeId, nodeId),
        eq(nodeProviders.name, providerName),
      ));
    const cursorHandshake = (options.deliveryCursorSupported ?? true) && (provider?.capabilities?.some(
      (capability) => capability.name === FLEET_DELIVERY_CURSOR_CAPABILITY,
    ) ?? false);

    const [target] = await tx
      .select()
      .from(agents)
      .where(and(
        eq(agents.workspaceId, workspaceId),
        eq(agents.name, message.name),
      ));
    if (!target) {
      throw codedError(`Agent "${message.name}" not found`, 'agent_not_found', 404);
    }
    if (target.id !== message.expected_agent_id || target.originNodeId !== nodeId) {
      throw codedError(
        `Node "${nodeId}" does not own expected agent "${message.expected_agent_id}"`,
        'agent_recovery_not_authorized',
        403,
      );
    }

    const activeNodeIds = await activeBindingNodeIdsForAgent(tx, workspaceId, target.id);
    const targetWasActive = activeNodeIds.includes(nodeId);
    let reservedTargetSlot = false;
    // D1 has no interactive transaction, so capacity must be acquired before
    // any agent/location mutation. A full node now fails with the incumbent
    // row and bindings untouched; a later failure releases this reservation.
    if (!targetWasActive) {
      await reserveNodeAgentSlot(tx, workspaceId, node);
      reservedTargetSlot = true;
    }
    try {
      const now = new Date().toISOString();
      const fleetMetadata = sql`json_object(
        'node_id', ${nodeId},
        'invocation_id', ${message.invocation_id ?? null},
        'registered_at', ${now}
      )`;
      const [result] = await tx
        .update(agents)
        .set({
          status: 'active',
          lastSeen: new Date(),
          metadata: sql`json_patch(COALESCE(${agents.metadata}, '{}'), ${fleetMetadata})`,
          locationType: 'via_node',
          locationNodeId: nodeId,
          providerName,
          resumable: message.resumable ?? false,
          sessionRef: message.session_ref ?? null,
        })
        .where(and(
          eq(agents.workspaceId, workspaceId),
          eq(agents.id, message.expected_agent_id),
          eq(agents.name, message.name),
          eq(agents.originNodeId, nodeId),
        ))
        .returning();
      if (!result) {
        throw codedError(
          `Agent "${message.name}" changed during node recovery`,
          'agent_identity_conflict',
          409,
        );
      }

      await autoJoinGeneral(tx, workspaceId, result.id);
      await upsertAgentNodeBinding(tx, workspaceId, result, nodeId, {
        sessionRef: message.session_ref ?? null,
        deactivateExisting: true,
      });
      await releaseNodeAgentSlots(
        tx,
        workspaceId,
        activeNodeIds.filter((activeNodeId) => activeNodeId !== nodeId),
      );
      // Rotate only after every fallible routing/capacity mutation. On Node the
      // surrounding transaction still makes the whole recovery atomic; on D1
      // the rotation+audit pair remains one atomic batch.
      const rotated = await rotateAgentIdentity(tx, {
        workspaceId,
        agentId: target.id,
        agentName: target.name,
      }, {
        authority: 'origin_node',
        actor: `node:${node.name}`,
        reason: 'explicit node identity recovery',
        sessionRef: message.session_ref ?? target.sessionRef,
        nodeId,
        originActor: 'node-control/agent.recover',
      }, 'recover', {
        requireAtomic: !hasInteractiveTransaction,
        alreadyAtomic: hasInteractiveTransaction,
      });

      return {
        agent_id: result.id,
        name: result.name,
        token: rotated.token,
        ...(cursorHandshake ? { delivery_ack_seq: result.deliveryAckSeq } : {}),
      };
    } catch (err) {
      if (reservedTargetSlot) await releaseNodeAgentSlots(tx, workspaceId, [nodeId]);
      throw err;
    }
  });
}

export async function deregisterAgentViaNode(
  db: Db,
  workspaceId: string,
  nodeId: string,
  message: { agent_id?: string; name?: string },
  deps?: InvocationCompletionDeps,
) {
  const conditions = [
    eq(agents.workspaceId, workspaceId),
    eq(agents.locationType, 'via_node'),
    eq(agents.locationNodeId, nodeId),
  ];
  if (message.agent_id) {
    conditions.push(eq(agents.id, message.agent_id));
  } else if (message.name) {
    conditions.push(eq(agents.name, message.name));
  } else {
    return null;
  }

  const [updated] = await db
    .update(agents)
    .set({ status: 'offline', lastSeen: new Date() })
    .where(and(...conditions))
    .returning();
  if (updated) {
    const activeNodeIds = await activeBindingNodeIdsForAgent(db, workspaceId, updated.id);
    await db
      .update(agentNodeBindings)
      .set({ status: 'inactive', updatedAt: new Date() })
      .where(and(
        eq(agentNodeBindings.workspaceId, workspaceId),
        eq(agentNodeBindings.nodeId, nodeId),
        eq(agentNodeBindings.agentId, updated.id),
        eq(agentNodeBindings.status, 'active'),
      ));
    await releaseNodeAgentSlots(db, workspaceId, [nodeId]);
    await ensureDirectNodeForAgent(db, workspaceId, updated, { force: true });
    await db
      .update(agents)
      .set({ status: 'offline', lastSeen: new Date() })
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, updated.id)));
    await markDirectNodeOfflineForAgent(db, workspaceId, updated.id);
    await releaseNodeAgentSlots(db, workspaceId, activeNodeIds.filter((activeNodeId) => activeNodeId !== nodeId));

    if (deps) {
      await emitAgentExitedEffects(deps, workspaceId, {
        agentId: updated.id,
        agentName: updated.name,
        nodeId,
        invocationId: fleetInvocationId(updated.metadata),
        reason: 'deregistered',
      });
    }
  }
  return updated ?? null;
}

export async function reconcileInventory(
  db: Db,
  registry: NodeConnectionRegistry,
  workspaceId: string,
  nodeId: string,
  providerName: string,
  inventoryAgents: FleetInventoryAgent[],
  completionDeps?: InvocationCompletionDeps,
) {
  const names = new Set(inventoryAgents.map((agent) => agent.name));
  const liveInvocationIds = new Set(inventoryAgents.flatMap((agent) => (
    agent.invocation_id ? [agent.invocation_id] : []
  )));
  let completedInvocations = 0;
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)));
  if (!node) throw codedError(`Node "${nodeId}" not found`, 'node_not_found', 404);

  // Pre-validate every item against the current state BEFORE mutating anything,
  // so a conflict on a later item can't leave earlier items partially
  // reconciled (the control handler turns a throw into an error reply). Existing
  // rows are cached for reuse in the apply pass below.
  const existingByName = new Map<string, typeof agents.$inferSelect>();
  for (const item of inventoryAgents) {
    const [existing] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, item.name)));
    if (!existing) continue;
    if (existing.providerName !== providerName) {
      throw codedError(
        `Agent "${item.name}" belongs to provider "${existing.providerName}"`,
        'agent_provider_conflict',
        409,
      );
    }
    if (existing.status === 'active') {
      const [boundNode] = await db
        .select()
        .from(nodes)
        .where(and(
          eq(nodes.workspaceId, workspaceId),
          eq(nodes.id, existing.locationNodeId ?? ''),
        ));
      const boundNodeLive = !!boundNode && isNodeLive(boundNode);
      const conflict = existing.locationType !== 'via_node'
        || !existing.locationNodeId
        || (existing.locationNodeId !== nodeId && boundNodeLive && !isImplicitDirectLocation(existing));
      if (conflict) {
        console.warn('[node.inventory] rejected active-name claim', {
          workspace_id: workspaceId,
          node_id: nodeId,
          provider_name: providerName,
          agent_id: existing.id,
          agent_name: existing.name,
          existing_location_type: existing.locationType,
          existing_location_node_id: existing.locationNodeId,
        });
        throw codedError(`Agent "${item.name}" is already active on another live location`, 'agent_location_conflict', 409);
      }
    }
    if (existing.id !== item.agent_id) {
      throw codedError(
        `Inventory identity for agent "${item.name}" does not match its registered agent_id`,
        'agent_identity_mismatch',
        409,
      );
    }
    existingByName.set(item.name, existing);
  }

  const openInvocations = await db
    .select({
      id: actionInvocations.id,
      workspaceId: actionInvocations.workspaceId,
      actionName: actionInvocations.actionName,
      callerId: actionInvocations.callerId,
      input: actionInvocations.input,
      status: actionInvocations.status,
      dispatchedNodeId: actionInvocations.dispatchedNodeId,
      dispatchedProvider: actionInvocations.dispatchedProvider,
      spawnReservedAt: actionInvocations.spawnReservedAt,
      attemptedNodeIds: actionInvocations.attemptedNodeIds,
      dispatchAttempts: actionInvocations.dispatchAttempts,
    })
    .from(actionInvocations)
    .where(and(
      eq(actionInvocations.workspaceId, workspaceId),
      eq(actionInvocations.dispatchedNodeId, nodeId),
      eq(actionInvocations.dispatchedProvider, providerName),
      inArray(actionInvocations.status, ['pending', 'dispatched']),
    ));
  const providerInvocationIds = new Set(openInvocations.map((invocation) => invocation.id));

  const reconciledAgentIds: string[] = [];
  const newlyRoutedAgentIds: string[] = [];
  for (const item of inventoryAgents) {
    const existing = existingByName.get(item.name);
    if (existing) {
      const activeNodeIds = await activeBindingNodeIdsForAgent(db, workspaceId, existing.id);
      const targetWasActive = activeNodeIds.includes(nodeId);
      const wasRoutableThroughProvider = existing.locationType === 'via_node'
        && existing.locationNodeId === nodeId
        && targetWasActive;
      let reservedTargetSlot = false;
      try {
        if (!targetWasActive) {
          await reserveNodeAgentSlot(db, workspaceId, node);
          reservedTargetSlot = true;
        }
        await db
          .update(agents)
          .set({
            status: 'active',
            lastSeen: new Date(),
            locationType: 'via_node',
            locationNodeId: nodeId,
            originNodeId: existing.originNodeId ?? nodeId,
            sessionRef: item.session_ref ?? existing.sessionRef,
          })
          .where(eq(agents.id, existing.id));
        await upsertAgentNodeBinding(db, workspaceId, existing, nodeId, {
          sessionRef: item.session_ref ?? existing.sessionRef,
          deactivateExisting: true,
        });
        await releaseNodeAgentSlots(db, workspaceId, activeNodeIds.filter((activeNodeId) => activeNodeId !== nodeId));
        reconciledAgentIds.push(existing.id);
        if (!wasRoutableThroughProvider) newlyRoutedAgentIds.push(existing.id);
      } catch (err) {
        if (reservedTargetSlot) {
          await releaseNodeAgentSlots(db, workspaceId, [nodeId]);
        }
        throw err;
      }
    }

    if (!item.invocation_id || !providerInvocationIds.has(item.invocation_id)) continue;
    const completed = await completeNodeInvocation(db, registry, workspaceId, nodeId, providerName, item.invocation_id, {
      output: {
        agent_id: item.agent_id,
        name: item.name,
        invocation_id: item.invocation_id ?? null,
        session_ref: item.session_ref ?? null,
      },
    }, completionDeps);
    if (completed) {
      completedInvocations++;
      if (completionDeps) {
        await emitInvocationCompletionEffects(completionDeps, workspaceId, completed);
      }
    }
  }

  const nodeAgents = await db
    .select({ id: agents.id, name: agents.name, metadata: agents.metadata })
    .from(agents)
    .where(and(
      eq(agents.workspaceId, workspaceId),
      eq(agents.locationType, 'via_node'),
      eq(agents.locationNodeId, nodeId),
      eq(agents.providerName, providerName),
      eq(agents.status, 'active'),
    ));
  const missingAgents = nodeAgents.filter((agent) => !names.has(agent.name));
  const missing = missingAgents.map((agent) => agent.id);
  if (missing.length > 0) {
    await db
      .update(agents)
      .set({ status: 'offline', lastSeen: new Date() })
      .where(inArray(agents.id, missing));
    if (completionDeps) {
      for (const agent of missingAgents) {
        await emitAgentExitedEffects(completionDeps, workspaceId, {
          agentId: agent.id,
          agentName: agent.name,
          nodeId,
          invocationId: fleetInvocationId(agent.metadata),
          reason: 'missing_from_inventory',
        });
      }
    }
  }

  let rescheduledInvocations = 0;
  for (const invocation of openInvocations) {
    if (liveInvocationIds.has(invocation.id)) continue;
    try {
      if (await rescheduleNodeInvocation(db, registry, invocation)) {
        rescheduledInvocations++;
      }
    } catch {
      await db
        .update(actionInvocations)
        .set({
          status: 'pending',
          dispatchedNodeId: null,
          dispatchedProvider: null,
          dispatchedAt: null,
          retryAfterAt: new Date(Date.now() + 5_000),
        })
        .where(eq(actionInvocations.id, invocation.id));
    }
  }

  return {
    reply: {
      rebound_agents: reconciledAgentIds.length,
      open_invocations: openInvocations.length,
      completed_invocations: completedInvocations,
      rescheduled_invocations: rescheduledInvocations,
    },
    reconciledAgentIds,
    newlyRoutedAgentIds,
  };
}

export async function listNodes(
  db: Db,
  workspaceId: string,
  filters: { capability?: string; name?: string } = {},
) {
  const rows = await db.select().from(nodes).where(eq(nodes.workspaceId, workspaceId));
  return rows
    .filter((node) => !filters.name || node.name === filters.name)
    .filter((node) => !filters.capability || nodeHasCapability(node, filters.capability))
    .map(publicNode);
}

export async function getPublicNode(db: Db, workspaceId: string, name: string) {
  const node = await getNodeByName(db, workspaceId, name);
  return node ? publicNode(node) : null;
}

/** The node's persisted `status` column, or undefined when the node is gone. */
async function readNodeStatus(db: Db, workspaceId: string, nodeId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ status: nodes.status })
    .from(nodes)
    .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)));
  return row?.status;
}

async function readHeartbeatDrainState(
  db: Db,
  workspaceId: string,
  nodeId: string,
  providerName: string,
) {
  const [nodeRows, providerRows] = await Promise.all([
    db
      .select({
        status: nodes.status,
        handlersLive: nodes.handlersLive,
        maxAgents: nodes.maxAgents,
        activeAgents: nodes.activeAgents,
        reservedAgents: nodes.reservedAgents,
        lastHeartbeatAt: nodes.lastHeartbeatAt,
      })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId))),
    db
      .select({
        status: nodeProviders.status,
        handlersLive: nodeProviders.handlersLive,
        lastHeartbeatAt: nodeProviders.lastHeartbeatAt,
      })
      .from(nodeProviders)
      .where(and(
        eq(nodeProviders.workspaceId, workspaceId),
        eq(nodeProviders.nodeId, nodeId),
        eq(nodeProviders.name, providerName),
      )),
  ]);
  return { node: nodeRows[0], provider: providerRows[0] };
}

/**
 * A steady heartbeat only refreshes liveness metadata; draining every such
 * frame turns node cadence into a workspace-wide pending-invocation scan. A
 * drain is needed only when the heartbeat makes queued work dispatchable.
 */
function shouldDrainAfterHeartbeat(
  prior: Awaited<ReturnType<typeof readHeartbeatDrainState>>,
  current: ReturnType<typeof publicNode> | null,
  message: FleetNodeHeartbeatMessage,
): boolean {
  if (!current?.live) return false;
  if (!prior.node || !isNodeLive(prior.node)) return true;
  if (!prior.node.handlersLive && current.handlers_live) return true;

  // A provider can become dispatchable while another provider kept the node's
  // aggregate handlers_live flag true, so preserve the provider transition too.
  if (
    message.handlers_live
    && (!prior.provider || !isProviderLive(prior.provider) || !prior.provider.handlersLive)
  ) {
    return true;
  }

  const currentHasCapacity = current.max_agents === 0
    || current.active_agents + prior.node.reservedAgents < current.max_agents;
  return !nodeHasCapacity(prior.node) && currentHasCapacity;
}

/**
 * Emit a durable `node.status.online` only on a real offline -> online
 * transition: the node was not `online` before the register/heartbeat and the
 * resulting descriptor reports online. A steady heartbeat (already online) or a
 * register that leaves the node offline (no live provider) emits nothing.
 */
async function emitNodeOnlineTransition(
  deps: InvocationCompletionDeps | undefined,
  workspaceId: string,
  priorStatus: string | undefined,
  node: { id: string; name: string; status: string } | null,
): Promise<void> {
  if (!deps || !node || priorStatus === 'online' || node.status !== 'online') return;
  await emitNodeStatusEffects(deps, workspaceId, {
    status: 'online',
    nodeId: node.id,
    nodeName: node.name,
  });
}

function sendControl(socket: NodeSocketLike | undefined, payload: Record<string, unknown>): boolean {
  if (!socket) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    // The close handler will clean up the socket.
    return false;
  }
}

export async function handleNodeControlMessage(args: HandleNodeControlMessageArgs) {
  let message: FleetBrokerToRelaycastMessage;
  try {
    message = parseFleetBrokerToRelaycastMessage(JSON.parse(args.raw));
  } catch (err) {
    sendControl(args.socket, {
      v: 1,
      id: generateId(),
      type: 'error',
      ok: false,
      code: 'invalid_message',
      message: err instanceof Error ? err.message : 'Invalid node control message',
    });
    return;
  }

  // A provider binds its name to the connection at node.register; later frames
  // (heartbeat, deregister, agent.register, results) resolve it from the
  // connection. Absent a bound provider (or when driven without a registry
  // connection), fall back to the synthetic `default` provider.
  //
  // Resolve this at frame ARRIVAL, before entering the per-node queue: if the
  // socket closes while this frame is queued, `onNodeConnectionClose` clears the
  // connection's provider binding synchronously, and a lookup inside the callback
  // would then fall back to `default` and act on the wrong provider.
  const boundProviderName = args.connectionId
    ? args.registry.providerNameForConnection?.(args.connectionId)
    : undefined;
  // The connection's registered identity is authoritative — a provider can't act
  // on another provider by putting a different name in the frame. The frame's
  // provider is only a hint for unbound/back-compat traffic.
  const frameProviderName = boundProviderName
    ?? ('provider' in message && message.provider ? message.provider.name : undefined)
    ?? DEFAULT_PROVIDER_NAME;

  // Serialize all control operations for a node so a concurrent register and
  // teardown (or two providers attaching at once) can't race the duplicate
  // check, the provider-row upsert, or the aggregate recompute.
  return serializeNodeOp(args.workspaceId, args.nodeId, async () => {
  try {
    switch (message.type) {
      case 'node.register': {
        const provider = resolveProviderIdentity(message, args.connectionId);
        if (args.connectionId && args.registry.providerAttachConflict) {
          const conflict = args.registry.providerAttachConflict(
            args.workspaceId,
            args.nodeId,
            provider.name,
            provider.instance_id,
            args.connectionId,
          );
          if (conflict) {
            throw codedError(conflict.message, conflict.code, 409);
          }
        }
        const priorStatus = await readNodeStatus(args.db, args.workspaceId, args.nodeId);
        const registered = await registerNode(args.db, args.workspaceId, args.nodeId, message, provider);
        const readinessSupported = supportsProviderDeliveryReadiness(args.registry);
        const acceptance = registered.acceptance.map((capability) => (
          capability.name === FLEET_DELIVERY_CURSOR_CAPABILITY && !readinessSupported
            ? { ...capability, accepted: false, reason: 'delivery_readiness_unsupported' }
            : capability
        ));
        const cursorHandshake = acceptance.some(
          (capability) => capability.accepted && capability.name === FLEET_DELIVERY_CURSOR_CAPABILITY,
        );
        if (args.connectionId && args.registry.attachProvider) {
          args.registry.attachProvider(
            args.workspaceId,
            args.nodeId,
            provider.name,
            provider.instance_id,
            args.connectionId,
          );
        }
        args.registry.setProviderDeliveryReadiness?.(
          args.workspaceId,
          args.nodeId,
          provider.name,
          args.connectionId,
          cursorHandshake ? 'agent_scoped' : 'immediate',
        );
        sendControl(args.socket, {
          v: 1,
          id: requestId(message),
          type: 'reply',
          ok: true,
          data: {
            ...registered.node,
            provider: registered.provider,
            accepted_capabilities: acceptance,
          },
        });
        // The node row is already persisted online, so emit the durable
        // transition before draining: a drainNode rejection must not skip the
        // node.status.online event. Isolated so its own failure can't either.
        await emitNodeOnlineTransition(args.completionDeps, args.workspaceId, priorStatus, registered.node)
          .catch((err) => console.error('[node.status] online event emission failed', err));
        // Node is now marked online: flush any queued action.invoke frames so
        // spawns queued while it was offline can reserve capacity and dispatch.
        // Reconnect makes deferred work dispatchable too; bypass a retry delay
        // that may have been armed only because the prior socket was unavailable.
        await args.registry.drainNode(args.workspaceId, args.nodeId, { includeDeferred: true });
        // The success reply was already sent above; keep the pending flush
        // best-effort so a delivery error cannot trigger a second error reply
        // for the same request id from the outer catch.
        // Cursor-aware providers seed each resumed identity through
        // `agent.register`; replaying here would race every cursor reply. Legacy
        // providers retain immediate reconnect replay, scoped to their socket so
        // one provider cannot flush another provider's mailbox.
        if (!cursorHandshake) {
          await deliverPendingToNode(
            args.db,
            args.registry,
            args.workspaceId,
            args.nodeId,
            { providerName: provider.name },
          ).catch(() => {});
        }
        return;
      }
      case 'node.heartbeat': {
        const prior = await readHeartbeatDrainState(
          args.db,
          args.workspaceId,
          args.nodeId,
          frameProviderName,
        );
        const beat = await heartbeatNode(args.db, args.workspaceId, args.nodeId, frameProviderName, message);
        // The node row is already persisted, so emit the durable online
        // transition before draining: a drainNode rejection must not skip the
        // node.status.online event. Isolated so its own failure can't either.
        await emitNodeOnlineTransition(args.completionDeps, args.workspaceId, prior.node?.status, beat)
          .catch((err) => console.error('[node.status] online event emission failed', err));
        if (shouldDrainAfterHeartbeat(prior, beat, message)) {
          // A readiness transition invalidates the old backoff condition. Include
          // retry-delayed rows in this one bounded pass so a transition just
          // before retryAfterAt cannot strand work until another reconnect.
          await args.registry.drainNode(args.workspaceId, args.nodeId, { includeDeferred: true });
        }
        return;
      }
      case 'node.deregister':
        await deregisterProvider(args.db, args.registry, args.workspaceId, args.nodeId, frameProviderName, args.completionDeps);
        return;
      case 'node.spawn': {
        // Handler-context `ctx.spawnAgent`: capacity-direct delegation to this
        // connection's own node capacity executor (the broker provider).
        // Bypasses action dispatch so a `spawn:<harness>` shadow handler cannot
        // re-enter itself. The target is always the connection's node — a node
        // credential cannot direct a spawn at another node.
        const result = await dispatchCapacitySpawn(
          args.db,
          args.workspaceId,
          {
            input: message.input,
            target_node_id: args.nodeId,
          },
          { nodeConnections: args.registry },
        );
        sendControl(args.socket, {
          v: 1,
          id: requestId(message),
          type: 'reply',
          ok: true,
          data: result as Record<string, unknown>,
        });
        return;
      }
      case 'agent.register': {
        const registered = await registerAgentViaNode(
          args.db,
          args.workspaceId,
          args.nodeId,
          frameProviderName,
          message,
          { deliveryCursorSupported: supportsProviderDeliveryReadiness(args.registry) },
        );
        // The relay broker's node_control client awaits a `reply` frame keyed by
        // the request id (it matches `pending_agent_registrations` by `reply.id`
        // and parses `data` as {agent_id, token, name} with deny_unknown_fields).
        // A bare `agent.registered` frame leaves the token-authority handshake
        // hanging until the 30s timeout, so spawn never completes. Reply in the
        // shape the shipped broker consumes. Cursor-aware brokers advertise a
        // node capability and receive the authoritative cumulative cursor before
        // the pending-delivery drain below; legacy strict parsers receive the
        // original three-field shape.
        const replySent = sendControl(args.socket, {
          v: 1,
          id: requestId(message),
          type: 'reply',
          ok: true,
          data: registered,
        });
        if (!replySent) return;
        args.registry.markProviderAgentsDeliveryReady?.(
          args.workspaceId,
          args.nodeId,
          frameProviderName,
          args.connectionId,
          [registered.agent_id],
        );
        // Only this identity is cursor-ready. A node-wide drain here could send
        // another resumed agent's pending frame before its own reply.
        await deliverPendingToNode(
          args.db,
          args.registry,
          args.workspaceId,
          args.nodeId,
          { providerName: frameProviderName, agentIds: [registered.agent_id] },
        );
        return;
      }
      case 'agent.recover': {
        const recovered = await recoverAgentViaNode(
          args.db,
          args.workspaceId,
          args.nodeId,
          frameProviderName,
          message,
          { deliveryCursorSupported: supportsProviderDeliveryReadiness(args.registry) },
        );
        const replySent = sendControl(args.socket, {
          v: 1,
          id: requestId(message),
          type: 'reply',
          ok: true,
          data: recovered,
        });
        if (!replySent) return;
        args.registry.markProviderAgentsDeliveryReady?.(
          args.workspaceId,
          args.nodeId,
          frameProviderName,
          args.connectionId,
          [recovered.agent_id],
        );
        await deliverPendingToNode(
          args.db,
          args.registry,
          args.workspaceId,
          args.nodeId,
          { providerName: frameProviderName, agentIds: [recovered.agent_id] },
        );
        return;
      }
      case 'agent.deregister':
        await deregisterAgentViaNode(args.db, args.workspaceId, args.nodeId, message, args.completionDeps);
        return;
      case 'inventory.sync': {
        const result = await reconcileInventory(
          args.db,
          args.registry,
          args.workspaceId,
          args.nodeId,
          frameProviderName,
          message.agents,
          args.completionDeps,
        );
        const replySent = sendControl(args.socket, {
          v: 1,
          id: requestId(message),
          type: 'reply',
          ok: true,
          data: result.reply,
        });
        if (!replySent) return;
        const newlyReadyAgentIds = result.reconciledAgentIds.filter((agentId) => (
          !isProviderAgentDeliveryReady(
            args.registry,
            args.workspaceId,
            args.nodeId,
            frameProviderName,
            agentId,
          )
        ));
        args.registry.markProviderAgentsDeliveryReady?.(
          args.workspaceId,
          args.nodeId,
          frameProviderName,
          args.connectionId,
          result.reconciledAgentIds,
        );
        // Inventory represents sessions that survived a transport reconnect and
        // therefore retain their in-memory cursors. Restrict replay to exactly
        // those provider-owned identities; restarted sessions not in inventory
        // become ready individually through `agent.register`.
        const replayAgentIds = [...new Set([...newlyReadyAgentIds, ...result.newlyRoutedAgentIds])];
        await deliverPendingToNode(
          args.db,
          args.registry,
          args.workspaceId,
          args.nodeId,
          { providerName: frameProviderName, agentIds: replayAgentIds },
        );
        return;
      }
      case 'action.result': {
        const completed = await completeNodeInvocation(
          args.db,
          args.registry,
          args.workspaceId,
          args.nodeId,
          frameProviderName,
          message.invocation_id,
          {
            ...(Object.prototype.hasOwnProperty.call(message, 'output') ? { output: message.output } : {}),
            ...(message.error ? { error: message.error } : {}),
          },
          args.completionDeps,
        );
        if (completed && args.completionDeps) {
          await emitInvocationCompletionEffects(args.completionDeps, args.workspaceId, completed);
        }
        return;
      }
      case 'delivery.ack':
        await ackDeliveriesUpToSeq(
          args.db,
          args.workspaceId,
          args.nodeId,
          frameProviderName,
          message.agent,
          message.up_to_seq,
        );
        return;
    }
  } catch (err) {
    const error = err as Error & { code?: string };
    const code = error.code ?? 'node_control_failed';
    // The rejection reaches the client only as the error frame below. Log it so
    // it is not invisible server-side: a rejected node.register/node.heartbeat
    // (e.g. node_name_conflict, a UNIQUE violation) otherwise leaves a node
    // running half-registered with no signal to operators. Warn, not error —
    // these are client/protocol rejections, not server faults.
    console.warn('[node.control] rejected message', {
      type: message.type,
      code,
      workspaceId: args.workspaceId,
      nodeId: args.nodeId,
      provider: frameProviderName,
      message: error.message,
    });
    sendControl(args.socket, {
      v: 1,
      id: requestId(message),
      type: 'error',
      ok: false,
      code,
      message: error.message,
    });
  }
  });
}
