import { eq, and } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { agents } from '../db/schema.js';
import { randomHex, sha256Hex } from '../lib/crypto.js';
import { codedError } from '../lib/httpError.js';

type Db = ReturnType<typeof getDb>;

export async function rotateAgentToken(db: Db, workspaceId: string, agentName: string) {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, agentName)));

  if (!agent) {
    throw codedError(`Agent "${agentName}" not found`, 'agent_not_found', 404);
  }

  const newToken = `at_live_${randomHex(16)}`;
  const newTokenHash = await sha256Hex(newToken);

  await db
    .update(agents)
    .set({ tokenHash: newTokenHash })
    .where(eq(agents.id, agent.id));

  return {
    name: agent.name,
    token: newToken,
  };
}
