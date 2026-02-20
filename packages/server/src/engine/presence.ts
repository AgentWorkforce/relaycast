import { eq } from 'drizzle-orm';
import { agents } from '../db/schema.js';
import type { getDb } from '../db/index.js';

/**
 * Get presence status for all agents in a workspace.
 * Queries PresenceDO for online agents and merges with DB agent list.
 */
export async function getPresence(
  db: ReturnType<typeof getDb>,
  presenceDO: DurableObjectNamespace,
  workspaceId: string,
): Promise<Array<{ agent_id: string; agent_name: string; status: 'online' | 'offline' }>> {
  const doId = presenceDO.idFromName(workspaceId);
  const stub = presenceDO.get(doId);

  const [allAgents, presenceRes] = await Promise.all([
    db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.workspaceId, workspaceId)),
    stub.fetch(new Request('http://do/status')),
  ]);

  if (allAgents.length === 0) return [];

  const { agents: onlineIds } = await presenceRes.json() as { agents: string[] };
  const onlineSet = new Set(onlineIds);

  return allAgents.map((agent) => ({
    agent_id: agent.id,
    agent_name: agent.name,
    status: onlineSet.has(agent.id) ? ('online' as const) : ('offline' as const),
  }));
}
