import type { CreateAgentRequest } from './types.js';

export interface RegisterAgentInput extends CreateAgentRequest {
  strict?: boolean;
}

export type RegisterOrRotateInput = CreateAgentRequest;

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
