import { and, eq, notInArray, sql } from 'drizzle-orm';
import type { FleetCapability, FleetCapabilityKind } from '@relaycast/types';
import type { getDb } from '../db/index.js';
import { actions, nodeProviders, nodes } from '../db/schema.js';
import { generateId } from './snowflake.js';
import { codedError } from '../lib/httpError.js';
import { NODE_LIVENESS_TTL_MS } from './placement.js';

type Db = ReturnType<typeof getDb>;
type ProviderRow = typeof nodeProviders.$inferSelect;

/**
 * The reserved provider synthesized for registrations that carry no `provider`
 * field. It keeps pre-provider clients (the current broker) working: their
 * capabilities, heartbeats, and hosted agents are all keyed to `default`.
 */
export const DEFAULT_PROVIDER_NAME = 'default';

/**
 * Classify a capability. A declared `action`/`capacity` kind is authoritative;
 * otherwise the name decides — `spawn`, `spawn:<harness>`, and `release` are
 * capacity (placement/delegation, never materialized), everything else is an
 * action (materialized and invoked).
 */
export function capabilityKind(capability: FleetCapability | string): FleetCapabilityKind {
  const name = typeof capability === 'string' ? capability : capability.name;
  const declared = typeof capability === 'string' ? undefined : capability.kind;
  if (declared === 'action' || declared === 'capacity') return declared;
  if (name === 'spawn' || name === 'release' || name.startsWith('spawn:')) return 'capacity';
  return 'action';
}

export function isProviderLive(
  provider: Pick<ProviderRow, 'status' | 'handlersLive' | 'lastHeartbeatAt'>,
  now = Date.now(),
): boolean {
  return (
    provider.status === 'online' &&
    provider.handlersLive &&
    !!provider.lastHeartbeatAt &&
    now - provider.lastHeartbeatAt.getTime() <= NODE_LIVENESS_TTL_MS
  );
}

export async function getProvider(db: Db, workspaceId: string, nodeId: string, name: string): Promise<ProviderRow | null> {
  const [row] = await db
    .select()
    .from(nodeProviders)
    .where(and(
      eq(nodeProviders.workspaceId, workspaceId),
      eq(nodeProviders.nodeId, nodeId),
      eq(nodeProviders.name, name),
    ));
  return row ?? null;
}

export async function listProviders(db: Db, workspaceId: string, nodeId: string): Promise<ProviderRow[]> {
  return db
    .select()
    .from(nodeProviders)
    .where(and(eq(nodeProviders.workspaceId, workspaceId), eq(nodeProviders.nodeId, nodeId)));
}

/**
 * Resolve the provider that hosts a capacity capability (e.g. `spawn:claude`) on
 * a node — the executor `ctx.spawnAgent` and native spawn dispatch target.
 */
export async function capacityProviderName(
  db: Db,
  workspaceId: string,
  nodeId: string,
  capability: string,
): Promise<string | null> {
  const providers = await listProviders(db, workspaceId, nodeId);
  for (const provider of providers) {
    const caps = Array.isArray(provider.capabilities) ? provider.capabilities : [];
    if (caps.some((cap) => cap.name === capability && capabilityKind(cap) === 'capacity')) {
      return provider.name;
    }
  }
  return null;
}

/** Persist a provider's registration, fully replacing its previous capability set. */
export async function upsertProvider(
  db: Db,
  workspaceId: string,
  nodeId: string,
  data: {
    name: string;
    instanceId: string;
    capabilities: FleetCapability[];
    maxAgents: number;
    version: string;
    handlersLive: boolean;
  },
): Promise<void> {
  const now = new Date();
  const existing = await getProvider(db, workspaceId, nodeId, data.name);
  if (existing) {
    await db
      .update(nodeProviders)
      .set({
        instanceId: data.instanceId,
        capabilities: data.capabilities,
        maxAgents: data.maxAgents,
        version: data.version,
        handlersLive: data.handlersLive,
        status: 'online',
        lastHeartbeatAt: now,
      })
      .where(eq(nodeProviders.id, existing.id));
    return;
  }
  await db.insert(nodeProviders).values({
    id: `nprov_${generateId()}`,
    workspaceId,
    nodeId,
    name: data.name,
    instanceId: data.instanceId,
    capabilities: data.capabilities,
    maxAgents: data.maxAgents,
    activeAgents: 0,
    load: 0,
    handlersLive: data.handlersLive,
    status: 'online',
    version: data.version,
    lastHeartbeatAt: now,
    createdAt: now,
  });
}

export async function heartbeatProvider(
  db: Db,
  workspaceId: string,
  nodeId: string,
  name: string,
  data: { load: number; activeAgents: number; handlersLive: boolean },
): Promise<void> {
  await db
    .update(nodeProviders)
    .set({
      load: data.load,
      activeAgents: data.activeAgents,
      handlersLive: data.handlersLive,
      status: 'online',
      lastHeartbeatAt: new Date(),
    })
    .where(and(
      eq(nodeProviders.workspaceId, workspaceId),
      eq(nodeProviders.nodeId, nodeId),
      eq(nodeProviders.name, name),
    ));
}

export async function markProviderOffline(db: Db, workspaceId: string, nodeId: string, name: string): Promise<void> {
  await db
    .update(nodeProviders)
    .set({ status: 'offline', handlersLive: false, load: 0, lastHeartbeatAt: new Date() })
    .where(and(
      eq(nodeProviders.workspaceId, workspaceId),
      eq(nodeProviders.nodeId, nodeId),
      eq(nodeProviders.name, name),
    ));
}

/** Remove a provider and the actions it materialized (provider-scoped deregister / prune). */
export async function removeProvider(db: Db, workspaceId: string, nodeId: string, name: string): Promise<void> {
  await db
    .delete(actions)
    .where(and(
      eq(actions.workspaceId, workspaceId),
      eq(actions.handlerNodeId, nodeId),
      eq(actions.handlerProvider, name),
    ));
  await db
    .delete(nodeProviders)
    .where(and(
      eq(nodeProviders.workspaceId, workspaceId),
      eq(nodeProviders.nodeId, nodeId),
      eq(nodeProviders.name, name),
    ));
}

/**
 * Materialize a provider's `action`-kind capabilities into node-scoped action
 * rows, fully replacing this provider's previous set. `capacity` entries are
 * ignored (they feed placement, not dispatch). The synthetic `default` provider
 * keeps the pre-provider behavior: its actions claim the workspace-global name
 * so triggers and `POST /v1/actions/:name/invoke` keep resolving them.
 */
export async function materializeProviderActions(
  db: Db,
  workspaceId: string,
  nodeId: string,
  providerName: string,
  capabilities: FleetCapability[],
): Promise<void> {
  const actionCaps = capabilities.filter((cap) => capabilityKind(cap) === 'action');
  const keepNames = actionCaps.map((cap) => cap.name);

  // Prune actions this provider previously materialized that it no longer offers.
  const pruneConditions = [
    eq(actions.workspaceId, workspaceId),
    eq(actions.handlerNodeId, nodeId),
    eq(actions.handlerProvider, providerName),
  ];
  await db.delete(actions).where(and(
    ...pruneConditions,
    keepNames.length > 0 ? notInArray(actions.name, keepNames) : sql`1 = 1`,
  ));

  const isDefault = providerName === DEFAULT_PROVIDER_NAME;
  for (const cap of actionCaps) {
    const name = cap.name;
    if (isDefault) {
      // Never clobber an agent-hosted action of the same name (legacy behavior).
      const [agentHosted] = await db
        .select({ id: actions.id })
        .from(actions)
        .where(and(eq(actions.workspaceId, workspaceId), eq(actions.name, name), sql`${actions.handlerNodeId} IS NULL`));
      if (agentHosted) continue;
    }

    const wantGlobal = isDefault || cap.global === true;
    if (wantGlobal) {
      const [existingGlobal] = await db
        .select({ id: actions.id, handlerNodeId: actions.handlerNodeId })
        .from(actions)
        .where(and(eq(actions.workspaceId, workspaceId), eq(actions.name, name), eq(actions.isGlobal, true)));
      if (existingGlobal && existingGlobal.handlerNodeId !== nodeId) {
        // The default provider does not steal a workspace name another node
        // already owns (first-writer-wins, matching legacy broker behavior);
        // an explicit `global: true` collides loudly.
        if (isDefault) continue;
        throw codedError(`Action "${name}" already claims the workspace-global alias`, 'action_name_conflict', 409);
      }
    }

    const [existing] = await db
      .select()
      .from(actions)
      .where(and(eq(actions.workspaceId, workspaceId), eq(actions.handlerNodeId, nodeId), eq(actions.name, name)));
    if (existing && existing.handlerProvider && existing.handlerProvider !== providerName) {
      throw codedError(`Action "${name}" is already registered by provider "${existing.handlerProvider}" on this node`, 'action_name_conflict', 409);
    }

    const wantQueue = cap.queue === true;
    if (existing) {
      await db
        .update(actions)
        .set({ handlerProvider: providerName, handlerAgentId: null, isGlobal: wantGlobal, queue: wantQueue, isActive: true })
        .where(eq(actions.id, existing.id));
    } else {
      await db.insert(actions).values({
        id: `act_${generateId()}`,
        workspaceId,
        name,
        description: `Node handler ${name}`,
        handlerAgentId: null,
        handlerNodeId: nodeId,
        handlerProvider: providerName,
        isGlobal: wantGlobal,
        queue: wantQueue,
        inputSchema: {},
        outputSchema: {},
        availableTo: null,
      });
    }
  }
}

/**
 * Recompute a broker node's aggregate columns from its providers: the union
 * manifest, summed capacity, max load, and OR'd liveness. Direct nodes never
 * call this — they carry no providers.
 */
export async function recomputeNodeAggregate(
  db: Db,
  workspaceId: string,
  nodeId: string,
  extra: { version?: string; machineId?: string | null } = {},
): Promise<void> {
  const providers = await listProviders(db, workspaceId, nodeId);
  const online = providers.filter((p) => p.status === 'online');

  const capabilityByName = new Map<string, FleetCapability>();
  for (const provider of providers) {
    for (const cap of provider.capabilities ?? []) {
      if (!capabilityByName.has(cap.name)) capabilityByName.set(cap.name, cap);
    }
  }

  const maxAgents = providers.reduce((sum, p) => sum + p.maxAgents, 0);
  const activeAgents = providers.reduce((sum, p) => sum + p.activeAgents, 0);
  const load = providers.reduce((max, p) => Math.max(max, p.load), 0);
  const handlersLive = online.some((p) => p.handlersLive);
  const lastHeartbeatAt = providers.reduce<Date | null>((latest, p) => {
    if (!p.lastHeartbeatAt) return latest;
    return !latest || p.lastHeartbeatAt > latest ? p.lastHeartbeatAt : latest;
  }, null);

  const update: Partial<typeof nodes.$inferInsert> = {
    capabilities: [...capabilityByName.values()],
    maxAgents,
    activeAgents,
    load,
    handlersLive,
    status: online.length > 0 ? 'online' : 'offline',
    lastHeartbeatAt: lastHeartbeatAt ?? new Date(),
  };
  if (extra.version !== undefined) update.version = extra.version;
  if (extra.machineId !== undefined && extra.machineId !== null) update.machineId = extra.machineId;

  await db.update(nodes).set(update).where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)));
}
