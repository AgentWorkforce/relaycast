import type { CreateAgentRequest } from './types.js';

export interface RegisterAgentInput extends CreateAgentRequest {
  strict?: boolean;
}

export type RegisterOrRotateInput = CreateAgentRequest;

/**
 * Register accepts the optional `recoveryProof` fallback: on a name conflict,
 * instead of failing closed it presents the proof to `agents.recover` and
 * returns a fresh token for the existing identity. Omitting it preserves the
 * create-only, fail-closed contract — the proof is the only thing that lets a
 * caller legitimately mint a new token for a name it does not currently hold.
 */
export type RegisterOrRecoverInput = CreateAgentRequest & {
  recoveryProof?: string;
};

export interface RecoverAgentInput {
  name: string;
  expectedAgentId: string;
  recoveryProof?: string;
  reason?: string;
  sessionRef?: string;
  nodeId?: string;
}

export interface TakeOverAgentInput {
  name: string;
  expectedAgentId: string;
  actor: string;
  reason: string;
  sessionRef: string;
  nodeId: string;
}

export interface RevokeAgentTokenInput {
  name: string;
  expectedAgentId: string;
  actor: string;
  reason: string;
  sessionRef?: string;
  nodeId?: string;
}

export interface EnrollRecoveryCredentialInput {
  recoveryProofHash: string;
  workUnitId?: string;
}

export interface AgentIdentityRecoveryResponse {
  agentId: string;
  name: string;
  token: string;
  auditId: string;
}

export interface AgentIdentityRevocationResponse {
  agentId: string;
  name: string;
  auditId: string;
}

export interface ResolvedIdentity {
  agentId: string;
  name: string;
  workspaceId: string;
}

const COMPAT_EVENT_NAME = 'relaycast.compatibility';
const emittedCompatibilityEvents = new Set<string>();

interface CompatibilityEventDetail {
  event: string;
  metadata: Record<string, unknown>;
}

export function emitCompatibilityTelemetry(
  event: string,
  metadata: Record<string, unknown> = {},
): void {
  if (emittedCompatibilityEvents.has(event)) return;
  emittedCompatibilityEvents.add(event);

  const target = globalThis as {
    dispatchEvent?: (event: Event) => boolean;
    CustomEvent?: typeof CustomEvent;
  };
  const CustomEventCtor = target.CustomEvent ?? globalThis.CustomEvent;

  if (typeof target.dispatchEvent !== 'function' || typeof CustomEventCtor !== 'function') {
    return;
  }

  const detail: CompatibilityEventDetail = { event, metadata };
  target.dispatchEvent(new CustomEventCtor(COMPAT_EVENT_NAME, { detail }));
}
