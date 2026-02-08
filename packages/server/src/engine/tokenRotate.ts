import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { agents } from '../db/schema.js';

export async function rotateAgentToken(workspaceId: string, agentName: string) {
  const db = getDb();

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, agentName)));

  if (!agent) {
    const err = new Error(`Agent "${agentName}" not found`);
    Object.assign(err, { code: 'agent_not_found', status: 404 });
    throw err;
  }

  const newToken = `at_live_${crypto.randomBytes(16).toString('hex')}`;
  const newTokenHash = crypto.createHash('sha256').update(newToken).digest('hex');

  await db
    .update(agents)
    .set({ tokenHash: newTokenHash })
    .where(eq(agents.id, agent.id));

  return {
    name: agent.name,
    token: newToken,
  };
}
