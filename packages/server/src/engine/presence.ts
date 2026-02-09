import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { agents } from '../db/schema.js';
import { getRedis } from '../redis/index.js';

const PRESENCE_TTL = 60; // seconds
const PRESENCE_SET_TTL = 90; // TTL for the set itself (slightly longer)

function presenceSetKey(workspaceId: string): string {
  return `presence:set:${workspaceId}`;
}

function presenceAgentKey(workspaceId: string, agentId: string): string {
  return `presence:${workspaceId}:${agentId}`;
}

export async function setPresence(workspaceId: string, agentId: string): Promise<boolean> {
  const redis = getRedis();
  const agentKey = presenceAgentKey(workspaceId, agentId);
  const setKey = presenceSetKey(workspaceId);

  const pipeline = redis.pipeline();
  pipeline.exists(agentKey);
  pipeline.set(agentKey, '1', 'EX', PRESENCE_TTL);
  pipeline.sadd(setKey, agentId);
  pipeline.expire(setKey, PRESENCE_SET_TTL);
  const results = await pipeline.exec();

  const existed = results && results[0] ? results[0][1] === 1 : true;
  return !existed; // true if newly online
}

export async function removePresence(workspaceId: string, agentId: string): Promise<boolean> {
  const redis = getRedis();
  const agentKey = presenceAgentKey(workspaceId, agentId);
  const setKey = presenceSetKey(workspaceId);

  const pipeline = redis.pipeline();
  pipeline.del(agentKey);
  pipeline.srem(setKey, agentId);
  const results = await pipeline.exec();

  const removed = results && results[0] ? (results[0][1] as number) > 0 : false;
  return removed;
}

export async function getPresence(
  workspaceId: string,
): Promise<Array<{ agent_id: string; agent_name: string; status: 'online' | 'offline' }>> {
  const db = getDb();
  const redis = getRedis();

  // Fetch all agents and online set in parallel
  const [allAgents, onlineIds] = await Promise.all([
    db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.workspaceId, workspaceId)),
    redis.smembers(presenceSetKey(workspaceId)),
  ]);

  if (allAgents.length === 0) {
    return [];
  }

  const onlineSet = new Set(onlineIds);

  // Verify online agents still have their TTL keys (handles expired agents still in set)
  if (onlineSet.size > 0) {
    const pipeline = redis.pipeline();
    const idsToCheck = Array.from(onlineSet);
    for (const id of idsToCheck) {
      pipeline.exists(presenceAgentKey(workspaceId, id));
    }
    const results = await pipeline.exec();

    // Remove stale entries from both the set and our local onlineSet
    const staleIds: string[] = [];
    idsToCheck.forEach((id, index) => {
      const exists = results && results[index] ? results[index][1] === 1 : false;
      if (!exists) {
        onlineSet.delete(id);
        staleIds.push(id);
      }
    });

    // Async cleanup of stale entries from the Redis set
    if (staleIds.length > 0) {
      redis.srem(presenceSetKey(workspaceId), ...staleIds).catch(() => {});
    }
  }

  return allAgents.map((agent) => ({
    agent_id: agent.id,
    agent_name: agent.name,
    status: onlineSet.has(agent.id) ? ('online' as const) : ('offline' as const),
  }));
}
