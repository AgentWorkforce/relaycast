import { and, eq } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { agents, nodes } from '../db/schema.js';
import { codedError } from '../lib/httpError.js';

type Db = ReturnType<typeof getDb>;

export interface AgentAddress {
  agent: string;
  machine: string;
}

/**
 * Parse an `agent@machine` address. The split is on the last `@` so agent
 * names that themselves contain `@` still resolve.
 */
export function parseAgentAddress(address: string): AgentAddress | null {
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return null;
  return { agent: address.slice(0, at), machine: address.slice(at + 1) };
}

/**
 * Resolve an `agent@machine` address to the agent currently hosted there.
 * `machine` matches the agent's location node by node name or `machine_id`,
 * so a stale address (the agent moved or was released) fails instead of
 * silently reaching the agent somewhere else.
 */
export async function resolveAgentAddress(db: Db, workspaceId: string, address: string) {
  const parsed = parseAgentAddress(address);
  if (!parsed) {
    throw codedError('Address must be of the form "agent@machine"', 'invalid_address', 400);
  }

  const [row] = await db
    .select({
      agentId: agents.id,
      agentName: agents.name,
      status: agents.status,
      nodeId: nodes.id,
      nodeName: nodes.name,
      machineId: nodes.machineId,
    })
    .from(agents)
    .leftJoin(nodes, eq(nodes.id, agents.locationNodeId))
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, parsed.agent)));

  if (
    !row
    || row.status === 'released'
    || (row.nodeName !== parsed.machine && row.machineId !== parsed.machine)
  ) {
    throw codedError(`No agent at address "${address}"`, 'address_not_found', 404);
  }

  return {
    address: `${row.agentName}@${parsed.machine}`,
    agent_id: row.agentId,
    agent_name: row.agentName,
    node_id: row.nodeId!,
  };
}
