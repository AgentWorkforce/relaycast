import { and, eq, inArray, sql } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { agentInboundPolicies, agents } from '../db/schema.js';
import { codedError } from '../lib/httpError.js';
import { queryInChunks } from '../lib/queryChunks.js';

type Db = ReturnType<typeof getDb>;

export type InboundPolicyMode = 'open' | 'allowlist';

export interface InboundPolicy {
  mode: InboundPolicyMode;
  allowedAgentIds: string[];
  pinnedAgentIds: string[];
}

export const OPEN_POLICY: InboundPolicy = { mode: 'open', allowedAgentIds: [], pinnedAgentIds: [] };

/** Who is asking to change a policy: the agent itself, or the workspace key. */
export type InboundPolicyActor = { kind: 'workspace' } | { kind: 'agent'; agentId: string };

/**
 * Whether `senderId` may address an agent holding `policy`. An agent can
 * always address itself; otherwise an allowlist admits only its own and its
 * pinned members.
 */
export function policyAdmits(policy: InboundPolicy, senderId: string, recipientId: string): boolean {
  if (senderId === recipientId || policy.mode === 'open') return true;
  return policy.allowedAgentIds.includes(senderId) || policy.pinnedAgentIds.includes(senderId);
}

interface StoredInboundPolicy {
  /** False when the agent has no row and is therefore open. */
  present: boolean;
  policy: InboundPolicy;
}

async function readStoredInboundPolicy(db: Db, workspaceId: string, agentId: string): Promise<StoredInboundPolicy> {
  const [row] = await db
    .select()
    .from(agentInboundPolicies)
    .where(and(eq(agentInboundPolicies.workspaceId, workspaceId), eq(agentInboundPolicies.agentId, agentId)));
  if (!row) return { present: false, policy: OPEN_POLICY };
  return {
    present: true,
    policy: { mode: row.mode, allowedAgentIds: row.allowedAgentIds, pinnedAgentIds: row.pinnedAgentIds },
  };
}

export async function getInboundPolicy(db: Db, workspaceId: string, agentId: string): Promise<InboundPolicy> {
  return (await readStoredInboundPolicy(db, workspaceId, agentId)).policy;
}

/** Policies for several agents at once; agents without a row are open. */
export async function getInboundPolicies(
  db: Db,
  workspaceId: string,
  agentIds: readonly string[],
): Promise<Map<string, InboundPolicy>> {
  const unique = [...new Set(agentIds)];
  const policies = new Map<string, InboundPolicy>(unique.map((id) => [id, OPEN_POLICY]));
  if (unique.length === 0) return policies;
  // One allowlist can name 256 agents. Chunk so workspaceId plus the IN list stays under D1's bind cap.
  const rows = await queryInChunks(unique, (chunk) => db
    .select()
    .from(agentInboundPolicies)
    .where(and(eq(agentInboundPolicies.workspaceId, workspaceId), inArray(agentInboundPolicies.agentId, chunk))));
  for (const row of rows) {
    policies.set(row.agentId, { mode: row.mode, allowedAgentIds: row.allowedAgentIds, pinnedAgentIds: row.pinnedAgentIds });
  }
  return policies;
}

/**
 * Refuse to let `senderId` address `recipient` unless its policy admits the
 * sender. The refusal is the same `agent_not_found` a nonexistent name gets,
 * so a sender outside the allowlist cannot learn the agent exists.
 */
export async function assertMayAddress(
  db: Db,
  workspaceId: string,
  senderId: string,
  recipient: { id: string; name: string },
): Promise<void> {
  if (senderId === recipient.id) return;
  const policy = await getInboundPolicy(db, workspaceId, recipient.id);
  if (!policyAdmits(policy, senderId, recipient.id)) {
    throw codedError(`Agent "${recipient.name}" not found`, 'agent_not_found', 404);
  }
}

/**
 * The first pair in a conversation whose policy refuses the other member, or
 * null when every restricted member admits everyone else. A restricted agent
 * may only share a group DM with agents it admits, so membership alone can
 * never become a way around its allowlist.
 */
export async function findConversationConflict(
  db: Db,
  workspaceId: string,
  memberIds: readonly string[],
): Promise<{ recipientId: string; senderId: string } | null> {
  const policies = await getInboundPolicies(db, workspaceId, memberIds);
  for (const [recipientId, policy] of policies) {
    if (policy.mode === 'open') continue;
    for (const senderId of policies.keys()) {
      if (!policyAdmits(policy, senderId, recipientId)) return { recipientId, senderId };
    }
  }
  return null;
}

/**
 * Members of `memberIds` whose policy refuses `senderId`. Used where a sender
 * posts into an existing conversation, since a policy may have narrowed after
 * the conversation formed.
 */
export async function refusingMembers(
  db: Db,
  workspaceId: string,
  senderId: string,
  memberIds: readonly string[],
): Promise<string[]> {
  const policies = await getInboundPolicies(db, workspaceId, memberIds);
  return [...policies].filter(([recipientId, policy]) => !policyAdmits(policy, senderId, recipientId)).map(([id]) => id);
}

/** Resolve agent names in this workspace to ids; unknown names are reported. */
async function resolveAgentNames(db: Db, workspaceId: string, names: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(names)];
  if (unique.length === 0) return new Map();
  const rows = await queryInChunks(unique, (chunk) => db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), inArray(agents.name, chunk))));
  const byName = new Map(rows.map((row) => [row.name, row.id]));
  const missing = unique.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    throw codedError(`Agent "${missing[0]}" not found`, 'agent_not_found', 404);
  }
  return byName;
}

async function namesFor(db: Db, workspaceId: string, ids: readonly string[]): Promise<{ id: string; name: string }[]> {
  if (ids.length === 0) return [];
  const rows = await queryInChunks([...ids], (chunk) => db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), inArray(agents.id, chunk))));
  const byId = new Map(rows.map((row) => [row.id, row.name]));
  // An admitted agent that was deleted drops out of the view; its id stays
  // inert in the row because a new agent never reuses an id.
  return ids.filter((id) => byId.has(id)).map((id) => ({ id, name: byId.get(id)! }));
}

export interface InboundPolicyView {
  agent_id: string;
  mode: InboundPolicyMode;
  allowed_agents: { id: string; name: string }[];
  pinned_agents: { id: string; name: string }[];
}

export async function inboundPolicyView(db: Db, workspaceId: string, agentId: string): Promise<InboundPolicyView> {
  const policy = await getInboundPolicy(db, workspaceId, agentId);
  return {
    agent_id: agentId,
    mode: policy.mode,
    allowed_agents: await namesFor(db, workspaceId, policy.allowedAgentIds),
    pinned_agents: await namesFor(db, workspaceId, policy.pinnedAgentIds),
  };
}

/**
 * Set an agent's inbound policy. The workspace key may set anything. An agent
 * may set only its own policy and only narrow it, because the agent acts on
 * text it receives: a peer must never be able to talk it into admitting more
 * senders. Widening, and any change to the pinned list, needs the workspace
 * key (the owner, through Cloud or the desktop app).
 */
export async function setInboundPolicy(
  db: Db,
  workspaceId: string,
  agentId: string,
  actor: InboundPolicyActor,
  input: { mode: InboundPolicyMode; allowedAgents?: string[]; pinnedAgents?: string[] },
): Promise<InboundPolicyView> {
  if (input.mode === 'open' && input.allowedAgents?.length) {
    throw codedError('An open policy admits everyone; omit allowed_agents', 'invalid_inbound_policy', 400);
  }
  const stored = await readStoredInboundPolicy(db, workspaceId, agentId);
  const current = stored.policy;
  const allowedByName = input.allowedAgents
    ? await resolveAgentNames(db, workspaceId, input.allowedAgents)
    : new Map<string, string>();
  if (actor.kind === 'agent') {
    // Naming an agent that refuses this one must not confirm it exists.
    const policies = await getInboundPolicies(db, workspaceId, [...allowedByName.values()]);
    for (const [name, id] of allowedByName) {
      if (!policyAdmits(policies.get(id)!, actor.agentId, id)) {
        throw codedError(`Agent "${name}" not found`, 'agent_not_found', 404);
      }
    }
  }
  const allowedIds = [...allowedByName.values()];

  let pinnedIds = current.pinnedAgentIds;
  if (actor.kind === 'agent') {
    if (actor.agentId !== agentId) {
      throw codedError('An agent may only set its own inbound policy', 'forbidden', 403);
    }
    if (input.pinnedAgents !== undefined) {
      throw codedError('Pinned agents are set with the workspace key', 'workspace_key_required', 403);
    }
    const narrows = current.mode === 'open'
      ? true
      : input.mode === 'allowlist' && allowedIds.every((id) => current.allowedAgentIds.includes(id));
    if (!narrows) {
      throw codedError(
        'An agent may only narrow its inbound policy; widening needs the workspace key',
        'inbound_policy_widen_forbidden',
        403,
      );
    }
  } else if (input.pinnedAgents !== undefined) {
    pinnedIds = [...(await resolveAgentNames(db, workspaceId, input.pinnedAgents)).values()];
  }

  // Pinned agents persist while the policy is open, so Cloud can pin the owner
  // and admins up front and an agent that later narrows never locks them out.
  const values = {
    mode: input.mode,
    allowedAgentIds: [...new Set(allowedIds)],
    pinnedAgentIds: [...new Set(pinnedIds)],
    updatedAt: new Date(),
  };
  if (actor.kind === 'workspace') {
    await db
      .insert(agentInboundPolicies)
      .values({ agentId, workspaceId, ...values })
      .onConflictDoUpdate({ target: agentInboundPolicies.agentId, set: values });
  } else {
    // Commit only when the row is still the one this call read. A later narrow
    // must not put back a name an earlier narrow removed. Pins are not part of
    // the predicate and are not rewritten: an agent cannot change them.
    await commitAgentNarrow(db, workspaceId, agentId, stored, values);
  }
  return inboundPolicyView(db, workspaceId, agentId);
}

function inboundPolicyConflict() {
  return codedError(
    'Inbound policy changed; retry the narrow against the current allowlist',
    'inbound_policy_conflict',
    409,
  );
}

/** Logical list equality. `json()` ignores stored whitespace; element order is the order that was read. */
function sameAllowedList(ids: readonly string[]) {
  return sql`json(${agentInboundPolicies.allowedAgentIds}) = json(${JSON.stringify([...ids])})`;
}

async function commitAgentNarrow(
  db: Db,
  workspaceId: string,
  agentId: string,
  stored: StoredInboundPolicy,
  values: { mode: InboundPolicyMode; allowedAgentIds: string[]; pinnedAgentIds: string[]; updatedAt: Date },
): Promise<void> {
  if (!stored.present) {
    const inserted = await db
      .insert(agentInboundPolicies)
      .values({ agentId, workspaceId, ...values })
      .onConflictDoNothing()
      .returning({ agentId: agentInboundPolicies.agentId });
    if (inserted.length === 0) throw inboundPolicyConflict();
    return;
  }
  const updated = await db
    .update(agentInboundPolicies)
    .set({ mode: values.mode, allowedAgentIds: values.allowedAgentIds, updatedAt: values.updatedAt })
    .where(and(
      eq(agentInboundPolicies.agentId, agentId),
      eq(agentInboundPolicies.workspaceId, workspaceId),
      eq(agentInboundPolicies.mode, stored.policy.mode),
      sameAllowedList(stored.policy.allowedAgentIds),
    ))
    .returning({ agentId: agentInboundPolicies.agentId });
  if (updated.length === 0) throw inboundPolicyConflict();
}
