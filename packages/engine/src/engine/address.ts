import { nodes } from '../db/schema.js';
import { codedError } from '../lib/httpError.js';

/**
 * Machine name for agents on a direct node (self-connected agents), whose node
 * name is an internal id rather than a machine.
 */
export const DIRECT_MACHINE = 'direct';

/** Server-owned message metadata key holding the sender's address at send time. */
export const SENDER_ADDRESS_METADATA_KEY = '__relaycast_sender_address';

export interface AgentAddress {
  agent: string;
  machine: string;
}

type AddressNode = { name: string; role: string; machineId: string | null } | null;

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
 * Canonical address: the broker node's name, or `direct` for a direct node.
 * Null when the agent has no node — released, finished, or its node was
 * deleted (a torn-down sandbox) — because nothing could deliver to it.
 */
export function formatAgentAddress(agentName: string, node: AddressNode): string | null {
  if (!node) return null;
  return `${agentName}@${node.role === 'direct' ? DIRECT_MACHINE : node.name}`;
}

/** Whether `machine` names the node the agent is on: node name, machine_id, or `direct`. */
function machineMatches(machine: string, node: AddressNode): boolean {
  if (!node) return false;
  if (machine === DIRECT_MACHINE && node.role === 'direct') return true;
  return machine === node.name || machine === node.machineId;
}

/** Node columns needed to format or match an address; select them via a left join on the agent's location node. */
export const addressNodeSelection = { name: nodes.name, role: nodes.role, machineId: nodes.machineId };

/** Reject an address that is not `agent@machine` before any other work. */
export function requireAgentAddress(address: string): AgentAddress {
  const parsed = parseAgentAddress(address);
  if (!parsed) {
    throw codedError('Address must be of the form "agent@machine"', 'invalid_address', 400);
  }
  return parsed;
}

/**
 * Throw unless `agent` (looked up by the address's agent name) is live and
 * hosted on the address's machine. A stale address (the agent moved or was
 * released) fails instead of silently reaching the agent somewhere else.
 */
export function assertAgentAtAddress(
  address: string,
  agent: { status: string } | undefined,
  node: AddressNode,
): void {
  const parsed = requireAgentAddress(address);
  if (!agent || agent.status === 'released' || !machineMatches(parsed.machine, node)) {
    throw addressNotFound(address);
  }
}

function addressNotFound(address: string) {
  return codedError(`No agent at address "${address}"`, 'address_not_found', 404);
}

/** `{ agent_address }` for a DM message whose persisted metadata carries the sender's address, else `{}`. */
export function senderAddressField(
  metadata: Record<string, unknown> | null | undefined,
): { agent_address?: string } {
  const value = metadata?.[SENDER_ADDRESS_METADATA_KEY];
  return typeof value === 'string' ? { agent_address: value } : {};
}
