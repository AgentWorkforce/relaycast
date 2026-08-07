import { and, eq, ne } from 'drizzle-orm';
import { agents } from '../db/schema.js';
import type { getDb } from '../db/index.js';
import type { PresenceTracker } from '../ports/presence.js';
import { RELEASED_AGENT_STATUS } from './agent.js';

/**
 * Get presence status for all agents in a workspace.
 * Queries the presence tracker for online agents and merges with the DB roster.
 */
export async function getPresence(
  db: ReturnType<typeof getDb>,
  presence: PresenceTracker,
  workspaceId: string,
): Promise<Array<{ agent_id: string; agent_name: string; status: 'online' | 'offline' }>> {
  const [allAgents, onlineIds] = await Promise.all([
    db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      // Released rows are tombstones kept only so history stays attributable.
      // They are not roster members and must not appear as presence entries.
      .where(and(eq(agents.workspaceId, workspaceId), ne(agents.status, RELEASED_AGENT_STATUS))),
    presence.getOnline(workspaceId),
  ]);

  if (allAgents.length === 0) return [];

  const onlineSet = new Set(onlineIds);

  return allAgents.map((agent) => ({
    agent_id: agent.id,
    agent_name: agent.name,
    status: onlineSet.has(agent.id) ? ('online' as const) : ('offline' as const),
  }));
}
