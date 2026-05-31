import { RelayError } from './errors.js';

export interface RegisterAgentInput {
  name: string;
  type?: 'agent' | 'human' | 'system';
  persona?: string;
  metadata?: Record<string, unknown>;
  strict?: boolean;
}

export type RegisterOrRotateInput = Omit<RegisterAgentInput, 'strict'>;

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

export function appendLegacySuffix(baseName: string): string {
  const suffix = Math.random().toString(16).slice(2, 6).padEnd(4, '0');
  return `${baseName}-${suffix}`;
}

export function isNameConflictError(err: unknown): err is RelayError {
  return err instanceof RelayError && err.code === 'name_conflict';
}
