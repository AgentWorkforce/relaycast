import { sql } from 'drizzle-orm';
import type { getDb } from '../db/index.js';

type Db = ReturnType<typeof getDb>;

const SUSPEND_AFTER_FAILURES = 3;

interface ActiveA2aAgentRow {
  id: string;
  workspace_id: string;
  relay_agent_id: string;
  external_url: string;
  health_failures: number;
}

export interface A2aHealthSweepResult {
  checked: number;
  healthy: number;
  failed: number;
  suspended: number;
}

function buildAgentCardUrl(externalUrl: string): string {
  const url = new URL(externalUrl);
  return `${url.origin}/.well-known/agent-card.json`;
}

async function pingExternalAgent(externalUrl: string): Promise<boolean> {
  try {
    const response = await globalThis.fetch(buildAgentCardUrl(externalUrl), {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function listActiveA2aAgents(db: Db): Promise<ActiveA2aAgentRow[]> {
  const rows = await db.all<ActiveA2aAgentRow>(sql`
    SELECT id, workspace_id, relay_agent_id, external_url, health_failures
    FROM a2a_agents
    WHERE status = 'active'
  `);

  return rows ?? [];
}

async function updateA2aAgentHealth(
  db: Db,
  agentId: string,
  status: 'active' | 'suspended',
  healthFailures: number,
): Promise<void> {
  await db.run(sql`
    UPDATE a2a_agents
    SET status = ${status}, health_failures = ${healthFailures}, last_health = unixepoch(), updated_at = unixepoch()
    WHERE id = ${agentId}
  `);
}

export async function runA2aHealthChecks(db: Db): Promise<A2aHealthSweepResult> {
  const agents = await listActiveA2aAgents(db);
  const result: A2aHealthSweepResult = {
    checked: agents.length,
    healthy: 0,
    failed: 0,
    suspended: 0,
  };

  for (const agent of agents) {
    const ok = await pingExternalAgent(agent.external_url);

    if (ok) {
      await updateA2aAgentHealth(db, agent.id, 'active', 0);
      result.healthy += 1;
      continue;
    }

    const failures = agent.health_failures + 1;
    const status = failures >= SUSPEND_AFTER_FAILURES ? 'suspended' : 'active';

    await updateA2aAgentHealth(db, agent.id, status, failures);
    result.failed += 1;
    if (status === 'suspended') {
      result.suspended += 1;
    }
  }

  return result;
}
