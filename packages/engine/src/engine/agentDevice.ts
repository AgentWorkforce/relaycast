import { and, eq } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { agentDeviceTokens, agents } from '../db/tables.js';
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
export const AGENT_DEVICE_TTL_MAX_SECONDS = 30 * 24 * 60 * 60;
export const AGENT_DEVICE_TTL_MIN_SECONDS = 60;

/** A device name as receivers see it: control characters become spaces, trimmed, at most 80 characters. */
export function normalizeDeviceName(value: string): string {
  return value.replace(/[\p{C}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, AGENT_DEVICE_NAME_MAX).trim();
}

export function validateDevice(input: { id: string; name: string; kind: string }): AgentDeviceStamp {
  if (!DEVICE_ID.test(input.id) || input.id === UNKNOWN_AGENT_DEVICE.id) {
    throw codedError('device.id must be 1-64 lowercase letters, digits or dashes, and not "unknown"', 'invalid_request', 400);
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
): Promise<{ agent_id: string; device: AgentDeviceStamp; token: string; expires_at: string | null }> {
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
  return { agent_id: agent.id, device, token, expires_at: expiresAt?.toISOString() ?? null };
}

/** Revoke one device's token at once. True when a token was deleted. */
export async function revokeAgentDeviceToken(
  db: Db,
  workspaceId: string,
  agentName: string,
  deviceId: string,
): Promise<boolean> {
  const agent = await personAgent(db, workspaceId, agentName);
  const deleted = await db
    .delete(agentDeviceTokens)
    .where(and(
      eq(agentDeviceTokens.workspaceId, workspaceId),
      eq(agentDeviceTokens.agentId, agent.id),
      eq(agentDeviceTokens.deviceId, deviceId),
    ))
    .returning({ id: agentDeviceTokens.id });
  return deleted.length > 0;
}

/** The delete that drops every device token of an agent (identity recovery, takeover, revocation). */
export function deleteAgentDeviceTokens(db: Db, workspaceId: string, agentId: string) {
  return db
    .delete(agentDeviceTokens)
    .where(and(eq(agentDeviceTokens.workspaceId, workspaceId), eq(agentDeviceTokens.agentId, agentId)));
}

/** The stamp of an authenticated device-token row. */
export function deviceStampOf(row: { deviceId: string; deviceName: string; deviceKind: string }): AgentDeviceStamp {
  const kind = (AGENT_DEVICE_KINDS as readonly string[]).includes(row.deviceKind)
    ? row.deviceKind as AgentDeviceKind
    : 'unknown';
  return { id: row.deviceId, name: row.deviceName, kind };
}
