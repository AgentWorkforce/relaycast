import {
  normalizeTelemetryOrigin,
  parseInternalTelemetryEvent,
  sanitizeTelemetryProperties,
  type InternalTelemetryEvent,
  type TelemetryOrigin,
} from '@relaycast/types';
import { getPostHogClient, telemetryEnabled } from './posthog.js';
import type { CloudflareBindings } from '../env.js';

export interface InternalTelemetryCaptureInput {
  event: InternalTelemetryEvent['event'];
  distinct_id: string;
  origin: Partial<TelemetryOrigin>;
  properties?: Record<string, unknown>;
}

export function workspaceDistinctId(workspaceId: string): string {
  return workspaceId;
}

export function buildInternalTelemetryEvent(input: InternalTelemetryCaptureInput): InternalTelemetryEvent {
  return parseInternalTelemetryEvent({
    event: input.event,
    distinct_id: input.distinct_id,
    properties: sanitizeTelemetryProperties(input.properties),
    ...normalizeTelemetryOrigin(input.origin),
  });
}

export async function captureInternalTelemetry(
  env: CloudflareBindings,
  input: InternalTelemetryCaptureInput | InternalTelemetryEvent,
): Promise<void> {
  if (!telemetryEnabled(env)) return;
  const apiKey = env.POSTHOG_API_KEY;
  if (!apiKey) return;

  const event = 'origin' in input
    ? buildInternalTelemetryEvent(input)
    : parseInternalTelemetryEvent(input);

  const client = getPostHogClient(env, apiKey);
  client.capture({
    distinctId: event.distinct_id,
    event: event.event,
    properties: {
      ...event.properties,
      origin_surface: event.origin_surface,
      origin_client: event.origin_client,
      origin_version: event.origin_version,
    },
  });
}

export async function captureInternalTelemetryBatched(
  env: CloudflareBindings,
  input: InternalTelemetryCaptureInput | InternalTelemetryEvent,
): Promise<void> {
  // Batching is handled automatically by the SDK client (flushAt: 20, flushInterval: 250)
  return captureInternalTelemetry(env, input);
}

export async function flushInternalTelemetryBatchesForTests(): Promise<void> {
  // Import and call directly to avoid any re-export edge cases
  const { flushAllPostHogClients } = await import('./posthog.js');
  await flushAllPostHogClients();
}
