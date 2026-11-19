import { and, eq, exists, gt, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { agentDeviceTokens, agents, nodes } from '../db/tables.js';
import { issueAgentDeviceCredential } from '../auth/credentials.js';
import { sha256Hex } from '../lib/crypto.js';
import { codedError } from '../lib/httpError.js';
import { generateId } from './snowflake.js';
import type { AgentDeviceStamp } from '../ports/auth.js';

type Db = ReturnType<typeof getDb>;

/**
 * Per-device tokens of a person agent.
 *
 * A person (`type: 'human'`) agent may hold, beside its shared token, one
 * token per device it signs in from. Each authenticates as the same agent;
 * what it sends is stamped by the server with its device
 * (`__relaycast_sender_device`, served as `agent_device`), so receivers see
 * which device spoke. The shared token keeps working and stamps an unknown
 * device.
 *
 * - Minted and revoked only with the workspace key (the host that owns the
 *   person's sign-ins, e.g. Agent Relay Cloud); a device token can never mint,
 *   revoke or rotate tokens.
 * - One live token per (agent, device id): a re-mint replaces the device's
 *   earlier token at once. Stored only as a SHA-256 hash; shown once.
 * - Token shapes `at_live_dv_…` / `ar_ad_…` select this table, so
 *   authentication stays one indexed lookup.
 * - The agent's identity recovery, takeover or revocation deletes all of its
 *   device tokens; `rotate-token` (the shared token's self-rollover) does not.
 *   Deleting the agent cascades.
 */

/** Kinds a device token can be minted for. `unknown` is only ever stamped, for the shared token. */
export const AGENT_DEVICE_KINDS = ['desktop', 'cli', 'web'] as const;
export type AgentDeviceKind = (typeof AGENT_DEVICE_KINDS)[number];

/** What a send with the shared person token (or a node / workspace key send as a person) is stamped with. */
export const UNKNOWN_AGENT_DEVICE: AgentDeviceStamp = { id: 'unknown', name: 'unknown', kind: 'unknown' };

/** Address-safe: lowercase letters, digits and single dashes, never `@`. `unknown` is reserved. */
const DEVICE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const AGENT_DEVICE_NAME_MAX = 80;
const RESERVED_DEVICE_IDS: ReadonlySet<string> = new Set(['unknown', 'direct']);
export const AGENT_DEVICE_TTL_MAX_SECONDS = 30 * 24 * 60 * 60;
export const AGENT_DEVICE_TTL_MIN_SECONDS = 60;

/** A device name as receivers see it: control characters become spaces, trimmed, at most 80 characters. */
export function normalizeDeviceName(value: string): string {
  return value.replace(/[\p{C}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, AGENT_DEVICE_NAME_MAX).trim();
}

export function validateDevice(input: { id: string; name: string; kind: string }): AgentDeviceStamp {
  // `unknown` is the shared token's stamp and `direct` its address machine
  // (<person>@direct): no device may look like the shared token.
  if (!DEVICE_ID.test(input.id) || RESERVED_DEVICE_IDS.has(input.id)) {
    throw codedError('device.id must be 1-64 lowercase letters, digits or dashes, and not "unknown" or "direct"', 'invalid_request', 400);
  }
  if (!(AGENT_DEVICE_KINDS as readonly string[]).includes(input.kind)) {
    throw codedError(`device.kind must be one of ${AGENT_DEVICE_KINDS.join(', ')}`, 'invalid_request', 400);
  }
  const name = normalizeDeviceName(input.name);
  if (!name) throw codedError('device.name is required', 'invalid_request', 400);
  return { id: input.id, name, kind: input.kind as AgentDeviceKind };
}

async function personAgent(db: Db, workspaceId: string, agentName: string) {
  const [agent] = await db
    .select({ id: agents.id, type: agents.type })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, agentName)));
  if (!agent) throw codedError(`Agent "${agentName}" not found`, 'agent_not_found', 404);
  return agent;
}

/**
 * Mint (or re-mint) `device`'s token for the person agent `agentName`.
 * `expectedAgentId` must be the agent's id, so a caller holding a stale id
 * never mints for a different agent that reused the name.
 */
export async function issueAgentDeviceToken(
  db: Db,
  workspaceId: string,
  agentName: string,
  input: { expectedAgentId: string; device: { id: string; name: string; kind: string }; ttlSeconds?: number },
): Promise<{ agent_id: string; device: AgentDeviceStamp; token: string; expires_at: string | null; replacedTokenHash: string | null }> {
  const device = validateDevice(input.device);
  if (input.ttlSeconds !== undefined && (!Number.isInteger(input.ttlSeconds)
    || input.ttlSeconds < AGENT_DEVICE_TTL_MIN_SECONDS || input.ttlSeconds > AGENT_DEVICE_TTL_MAX_SECONDS)) {
    throw codedError(
      `ttl_seconds must be an integer from ${AGENT_DEVICE_TTL_MIN_SECONDS} to ${AGENT_DEVICE_TTL_MAX_SECONDS}`,
      'invalid_request',
      400,
    );
  }
  const agent = await personAgent(db, workspaceId, agentName);
  if (agent.id !== input.expectedAgentId) {
    throw codedError(`Agent "${agentName}" is not the expected agent`, 'agent_identity_conflict', 409);
  }
  if (agent.type !== 'human') {
    throw codedError('Device tokens are issued only for person (type "human") agents', 'not_a_person_agent', 409);
  }
  const [previous] = await db
    .select({ tokenHash: agentDeviceTokens.tokenHash })
    .from(agentDeviceTokens)
    .where(and(
      eq(agentDeviceTokens.workspaceId, workspaceId),
      eq(agentDeviceTokens.agentId, agent.id),
      eq(agentDeviceTokens.deviceId, device.id),
    ));
  const token = await issueAgentDeviceCredential(db, workspaceId);
  const tokenHash = await sha256Hex(token);
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  const expiresAt = input.ttlSeconds === undefined ? null : new Date(now.getTime() + input.ttlSeconds * 1000);
  await db
    .insert(agentDeviceTokens)
    .values({
      id: `adt_${generateId()}`,
      workspaceId,
      agentId: agent.id,
      deviceId: device.id,
      deviceName: device.name,
      deviceKind: device.kind,
      tokenHash,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [agentDeviceTokens.workspaceId, agentDeviceTokens.agentId, agentDeviceTokens.deviceId],
      set: { deviceName: device.name, deviceKind: device.kind, tokenHash, expiresAt, updatedAt: now },
    });
  return {
    agent_id: agent.id, device, token, expires_at: expiresAt?.toISOString() ?? null,
    replacedTokenHash: previous?.tokenHash ?? null,
  };
}

/** Revoke one device's token at once. The agent and the revoked token's hash when one was deleted, else null. */
export async function revokeAgentDeviceToken(
  db: Db,
  workspaceId: string,
  agentName: string,
  deviceId: string,
): Promise<{ agentId: string; tokenHash: string } | null> {
  const agent = await personAgent(db, workspaceId, agentName);
  const deleted = await db
    .delete(agentDeviceTokens)
    .where(and(
      eq(agentDeviceTokens.workspaceId, workspaceId),
      eq(agentDeviceTokens.agentId, agent.id),
      eq(agentDeviceTokens.deviceId, deviceId),
    ))
    .returning({ id: agentDeviceTokens.id, tokenHash: agentDeviceTokens.tokenHash });
  return deleted[0] ? { agentId: agent.id, tokenHash: deleted[0].tokenHash } : null;
}

/**
 * The delete that drops every device token of an agent (identity recovery,
 * takeover, revocation, delete). With `onlyIfTokenHash`, it applies only when
 * the agent's shared token is now that hash, so a batch whose token change
 * lost a race (409) leaves the device tokens alone.
 */
export function deleteAgentDeviceTokens(db: Db, workspaceId: string, agentId: string, onlyIfTokenHash?: string) {
  return db
    .delete(agentDeviceTokens)
    .where(and(
      eq(agentDeviceTokens.workspaceId, workspaceId),
      eq(agentDeviceTokens.agentId, agentId),
      ...(onlyIfTokenHash === undefined ? [] : [exists(db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId), eq(agents.tokenHash, onlyIfTokenHash))))]),
    ));
}

/** The stamp of an authenticated device-token row. */
export function deviceStampOf(row: { deviceId: string; deviceName: string; deviceKind: string }): AgentDeviceStamp {
  const kind = (AGENT_DEVICE_KINDS as readonly string[]).includes(row.deviceKind)
    ? row.deviceKind as AgentDeviceKind
    : 'unknown';
  return { id: row.deviceId, name: row.deviceName, kind };
}

/**
 * The join and filter that keep a device-bound node token (nodes.device_token_hash)
 * alive only while the device token that minted it is: left-join this on a
 * node lookup and add the condition. An unbound node (NULL) is unaffected.
 */
export function nodeDeviceJoin() {
  return eq(agentDeviceTokens.tokenHash, nodes.deviceTokenHash);
}

export function liveNodeBinding(now: Date) {
  return or(
    isNull(nodes.deviceTokenHash),
    and(isNotNull(agentDeviceTokens.id), or(isNull(agentDeviceTokens.expiresAt), gt(agentDeviceTokens.expiresAt, now))),
  );
}

/** Whether `node`'s token is bound to a device token that is no longer live (revoked, re-minted, expired). */
export async function nodeBindingDead(db: Db, workspaceId: string, nodeId: string, now = new Date()): Promise<boolean> {
  const [row] = await db
    .select({ bound: nodes.deviceTokenHash, device: agentDeviceTokens.id, expiresAt: agentDeviceTokens.expiresAt })
    .from(nodes)
    .leftJoin(agentDeviceTokens, nodeDeviceJoin())
    .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)));
  if (!row?.bound) return false;
  return !row.device || (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime());
}

/** Whether the device token with this hash exists and has not expired. */
export async function deviceTokenLive(db: Db, tokenHash: string, now = new Date()): Promise<boolean> {
  const [row] = await db
    .select({ id: agentDeviceTokens.id })
    .from(agentDeviceTokens)
    .where(and(
      eq(agentDeviceTokens.tokenHash, tokenHash),
      or(isNull(agentDeviceTokens.expiresAt), gt(agentDeviceTokens.expiresAt, now)),
    ));
  return Boolean(row);
}

/** Which of these device-token hashes belong to live (unexpired) device tokens of the workspace. */
export async function liveDeviceTokenHashes(db: Db, workspaceId: string, hashes: readonly string[], now = new Date()): Promise<Set<string>> {
  if (hashes.length === 0) return new Set();
  const rows = await db
    .select({ tokenHash: agentDeviceTokens.tokenHash })
    .from(agentDeviceTokens)
    .where(and(
      eq(agentDeviceTokens.workspaceId, workspaceId),
      inArray(agentDeviceTokens.tokenHash, [...hashes]),
      or(isNull(agentDeviceTokens.expiresAt), gt(agentDeviceTokens.expiresAt, now)),
    ));
  return new Set(rows.map((row) => row.tokenHash));
}

/** Whether this node's current token is bound to a device token at all. */
export async function nodeIsDeviceBound(db: Db, workspaceId: string, nodeId: string): Promise<boolean> {
  const [row] = await db
    .select({ bound: nodes.deviceTokenHash })
    .from(nodes)
    .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)));
  return Boolean(row?.bound);
}

/** The hashes of every device token an agent holds now (read before an operation that drops them). */
export async function agentDeviceTokenHashes(db: Db, workspaceId: string, agentId: string): Promise<string[]> {
  const rows = await db
    .select({ tokenHash: agentDeviceTokens.tokenHash })
    .from(agentDeviceTokens)
    .where(and(eq(agentDeviceTokens.workspaceId, workspaceId), eq(agentDeviceTokens.agentId, agentId)));
  return rows.map((row) => row.tokenHash);
}

/** How long a heartbeat trusts a positive device check before reading it again. */
export const DEVICE_LIVENESS_RECHECK_MS = 5 * 60 * 1000;
const DEVICE_LIVENESS_CACHE_MAX = 10_000;
const deviceLiveness = new Map<string, { checkedAt: number; expiresAt: number | null }>();

/**
 * deviceTokenLive for the heartbeat of a socket opened with a device-bound
 * node token, without a database read on every beat: a live answer is reused
 * until the device's own expiry or DEVICE_LIVENESS_RECHECK_MS, whichever comes
 * first. Revocations do not wait for it: they close the device's sockets by
 * hash at once (this only bounds the backstop when such a close failed).
 */
export async function deviceTokenLiveCached(db: Db, tokenHash: string, now = Date.now()): Promise<boolean> {
  const cached = deviceLiveness.get(tokenHash);
  if (cached && now - cached.checkedAt < DEVICE_LIVENESS_RECHECK_MS && (cached.expiresAt === null || now < cached.expiresAt)) {
    return true;
  }
  const [row] = await db
    .select({ expiresAt: agentDeviceTokens.expiresAt })
    .from(agentDeviceTokens)
    .where(eq(agentDeviceTokens.tokenHash, tokenHash));
  const live = Boolean(row) && (row!.expiresAt === null || row!.expiresAt.getTime() > now);
  if (!live) {
    deviceLiveness.delete(tokenHash);
    return false;
  }
  if (deviceLiveness.size >= DEVICE_LIVENESS_CACHE_MAX) deviceLiveness.delete(deviceLiveness.keys().next().value!);
  deviceLiveness.set(tokenHash, { checkedAt: now, expiresAt: row!.expiresAt?.getTime() ?? null });
  return true;
}

/** Forget cached liveness for these device tokens (revocation in this process). */
export function forgetDeviceLiveness(tokenHashes: readonly string[]): void {
  for (const hash of tokenHashes) deviceLiveness.delete(hash);
}

const nodeBindingLiveness = new Map<string, number>();

/**
 * nodeBindingDead for checkpoint heartbeats of sockets whose host does not
 * track bindings, without a read on every beat: a "not dead" answer is reused
 * for DEVICE_LIVENESS_RECHECK_MS per node. A dead answer is never cached.
 */
export async function nodeBindingDeadCached(db: Db, workspaceId: string, nodeId: string, now = Date.now()): Promise<boolean> {
  const key = `${workspaceId}:${nodeId}`;
  const checkedAt = nodeBindingLiveness.get(key);
  if (checkedAt !== undefined && now - checkedAt < DEVICE_LIVENESS_RECHECK_MS) return false;
  const dead = await nodeBindingDead(db, workspaceId, nodeId, new Date(now));
  if (dead) {
    nodeBindingLiveness.delete(key);
    return true;
  }
  if (nodeBindingLiveness.size >= DEVICE_LIVENESS_CACHE_MAX) nodeBindingLiveness.delete(nodeBindingLiveness.keys().next().value!);
  nodeBindingLiveness.set(key, now);
  return false;
}
