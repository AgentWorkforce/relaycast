import type { TelemetryGroups, TelemetryPersonSetOnce } from '@relaycast/types';

/**
 * Pluggable telemetry sink — the observability seam.
 *
 * Self-host uses `NoopTelemetrySink` (honors `DO_NOT_TRACK` / explicit disable).
 * The cloud product injects a PostHog-backed sink. All methods are
 * fire-and-forget from the engine's perspective; the sink decides batching and
 * background flushing.
 */
export interface TelemetryEvent {
  /** Event name, e.g. `relaycast_server_message_posted`. */
  name: string;
  /** Server-resolved acting principal, separate from event target properties.
   * Credential hash is internal provenance only: never send it to analytics. */
  actor?: {
    workspaceId: string;
    agentId?: string;
    credentialHash?: string;
    senderType?: 'human' | 'agent' | 'system';
  };
  /** The person the event belongs to, or `relaycast-ws:<workspace_id>` when none is known. */
  distinctId: string;
  properties: Record<string, unknown>;
  /** PostHog groups (`$groups`); the host must verify Cloud ownership before using them. */
  groups?: TelemetryGroups;
  /** Person properties written once (`$set_once`). */
  setOnce?: TelemetryPersonSetOnce;
  /** `false` when `distinctId` is not a person (`$process_person_profile`). */
  processPersonProfile?: boolean;
}

export interface TelemetrySink {
  capture(event: TelemetryEvent): void;
  captureException(err: unknown, context?: Record<string, unknown>): void;
}
