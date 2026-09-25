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
 * Every way to read `address` as `agent@machine`. Agent names, node names and
 * machine ids may all contain `@`, so each separator is a candidate split; the
 * recipient lookup keeps the split that names a real agent on that machine.
 */
export function addressSplits(address: string): AgentAddress[] {
  const splits: AgentAddress[] = [];
  for (let at = address.indexOf('@'); at !== -1; at = address.indexOf('@', at + 1)) {
    if (at > 0 && at < address.length - 1) {
      splits.push({ agent: address.slice(0, at), machine: address.slice(at + 1) });
    }
  }
  return splits;
}

/**
 * Canonical address: the broker node's name, or `direct` for a direct node.
 * `direct` is reserved, so a broker whose name is `direct` is addressed by its
 * machine_id instead. A machine identifier without `@` is preferred, so the
 * address has one reading wherever the node offers one (an `@` in the machine
 * can make the address read as a different agent on a different machine).
 * Null when the agent has no node — released, finished, or its node was
 * deleted (a torn-down sandbox) — because nothing could deliver to it, or
 * when a broker has no usable identifier.
 */
export function formatAgentAddress(agentName: string, node: AddressNode): string | null {
  if (!node) return null;
  if (node.role === 'direct') return `${agentName}@${DIRECT_MACHINE}`;
  const usable = [node.name, node.machineId].filter((id): id is string => !!id && id !== DIRECT_MACHINE);
  const machine = usable.find((id) => !id.includes('@')) ?? usable[0];
  return machine ? `${agentName}@${machine}` : null;
}

/**
 * Whether `machine` names the node the agent is on. `direct` matches only a
 * direct node; a broker matches by node name or machine_id, never `direct`.
 */
export function machineMatches(machine: string, node: AddressNode): boolean {
  if (!node) return false;
  if (machine === DIRECT_MACHINE || node.role === 'direct') {
    return machine === DIRECT_MACHINE && node.role === 'direct';
  }
  return machine === node.name || machine === node.machineId;
}

/** Node columns needed to format or match an address; select them via a left join on the agent's location node. */
export const addressNodeSelection = { name: nodes.name, role: nodes.role, machineId: nodes.machineId };

/** Reject an address with no `agent@machine` reading before any other work. */
export function requireAgentAddress(address: string): AgentAddress[] {
  const splits = addressSplits(address);
  if (splits.length === 0) {
    throw codedError('Address must be of the form "agent@machine"', 'invalid_address', 400);
  }
  return splits;
}

/**
 * Pick the recipient `address` names from candidate agents (looked up by every
 * split's agent name). A stale address — the agent moved or was released —
 * matches nothing and fails instead of reaching the agent somewhere else.
 */
export function selectAddressedRecipient<T extends { agent: { name: string; status: string }; node: AddressNode }>(
  address: string,
  candidates: T[],
): T {
  const splits = requireAgentAddress(address);
  const matches = candidates.filter(({ agent, node }) => agent.status !== 'released'
    && splits.some((split) => split.agent === agent.name && machineMatches(split.machine, node)));
  if (matches.length > 1) {
    throw codedError(`Address "${address}" matches more than one agent`, 'ambiguous_address', 400);
  }
  if (!matches[0]) throw addressNotFound(address);
  return matches[0];
}

export function addressNotFound(address: string) {
  return codedError(`No agent at address "${address}"`, 'address_not_found', 404);
}

/** `{ agent_address }` for a DM message whose persisted metadata carries the sender's address, else `{}`. */
export function senderAddressField(
  metadata: Record<string, unknown> | null | undefined,
): { agent_address?: string } {
  const value = metadata?.[SENDER_ADDRESS_METADATA_KEY];
  return typeof value === 'string' ? { agent_address: value } : {};
}
