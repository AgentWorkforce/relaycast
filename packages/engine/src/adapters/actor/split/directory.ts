/**
 * The Workspace actor's side of the split topology: it stays the metadata
 * owner (credentials, the agent directory, channel rosters, node bindings)
 * and answers the gateway's lookups before a hot-path send is routed to a
 * Channel or Conversation actor.
 */
import { sha256Hex } from '../../../lib/crypto.js';
import type { EngineDeps } from '../../../ports/index.js';
import type { ActorSql } from '../database.js';
import { SplitResolveSchema, type AgentRef, type SplitResolveResult } from './protocol.js';

/** The engine's DM pair key: `dm_<key>` is the conversation id (engine/dm.ts `deriveDmPairKey`). */
export async function dmPairKey(workspaceId: string, agentA: string, agentB: string): Promise<string> {
  const [first, second] = [agentA, agentB].sort();
  return (await sha256Hex(`${workspaceId}:${first}:${second}`)).slice(0, 24);
}

/**
 * Authenticate an agent token and resolve what a send needs. Anything the
 * split path does not serve (an unknown recipient or channel, an archived
 * channel, a non-agent token) answers `ok: false`, and the gateway sends the
 * request through the Workspace actor's engine, which gives the exact error.
 */
export async function splitResolve(deps: EngineDeps, sql: ActorSql, workspaceId: string, raw: unknown): Promise<SplitResolveResult> {
  const input = SplitResolveSchema.parse(raw);
  const auth = await deps.auth.authenticate({ token: input.token, require: 'agent', db: deps.db });
  if (!auth.ok || !auth.agent || auth.workspace.id !== workspaceId) return { ok: false, reason: 'unauthenticated' };
  const sender = { id: auth.agent.id, name: auth.agent.name, address: `${auth.agent.name}@direct` };
  const result: Extract<SplitResolveResult, { ok: true }> = { ok: true, sender };

  if (input.dm_to !== undefined) {
    const [recipient] = sql.exec(
      'SELECT id, name FROM agents WHERE workspace_id = ? AND name = ?',
      workspaceId,
      input.dm_to,
    ) as AgentRef[];
    if (!recipient || recipient.id === sender.id) return { ok: false, reason: 'not_found' };
    const pairKey = await dmPairKey(workspaceId, sender.id, recipient.id);
    result.dm = { recipient, conversation_id: `dm_${pairKey}`, pair_key: pairKey };
  }

  if (input.channel !== undefined) {
    const [channel] = sql.exec(
      'SELECT id, name, is_archived FROM channels WHERE workspace_id = ? AND name = ? AND channel_type = 0',
      workspaceId,
      input.channel,
    ) as { id: string; name: string; is_archived: number | bigint | boolean }[];
    if (!channel || Number(channel.is_archived)) return { ok: false, reason: 'not_found' };
    const members = sql.exec(
      `SELECT a.id AS id, a.name AS name FROM channel_members m
       JOIN agents a ON a.id = m.agent_id
       WHERE m.channel_id = ? ORDER BY a.id`,
      channel.id,
    ) as AgentRef[];
    result.channel = { id: channel.id, name: channel.name, members };
  }
  return result;
}

/** The agents bound to `nodeId`: the gateway opens an inbox socket for each when the node connects. */
export function splitNodeAgents(sql: ActorSql, workspaceId: string, nodeId: string): AgentRef[] {
  return sql.exec(
    `SELECT a.id AS id, a.name AS name FROM agent_node_bindings b
     JOIN agents a ON a.id = b.agent_id
     WHERE b.workspace_id = ? AND b.node_id = ? AND b.status = 'active'
     ORDER BY a.id`,
    workspaceId,
    nodeId,
  ) as AgentRef[];
}
