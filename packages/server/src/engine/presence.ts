import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { agents } from '../db/schema.js';
import { getRedis } from '../redis/index.js';

const PRESENCE_TTL = 60; // seconds

export async function setPresence(workspaceId: string, agentId: string): Promise<boolean> {
  const redis = getRedis();
  const key = `presence:${workspaceId}:${agentId}`;
  const existed = await redis.exists(key);
  await redis.set(key, '1', 'EX', PRESENCE_TTL);
  return existed === 0; // true if newly online
}

export async function removePresence(workspaceId: string, agentId: string): Promise<boolean> {
  const redis = getRedis();
  const key = `presence:${workspaceId}:${agentId}`;
  const removed = await redis.del(key);
  return removed > 0;
}

export async function getPresence(
  workspaceId: string,
): Promise<Array<{ agent_id: string; agent_name: string; status: 'online' | 'offline' }>> {
  const db = getDb();
  const redis = getRedis();

  const allAgents = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(eq(agents.workspaceId, workspaceId));

  if (allAgents.length === 0) {
    return [];
  }

  const pipeline = redis.pipeline();
  for (const agent of allAgents) {
    pipeline.exists(`presence:${workspaceId}:${agent.id}`);
  }
  const results = await pipeline.exec();

  return allAgents.map((agent, index) => {
    const exists = results && results[index] ? results[index][1] === 1 : false;
    return {
      agent_id: agent.id,
      agent_name: agent.name,
      status: exists ? ('online' as const) : ('offline' as const),
    };
  });
}
