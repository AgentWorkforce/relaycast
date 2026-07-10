import {
  normalizeTelemetryOrigin,
  parseInternalTelemetryEvent,
  sanitizeTelemetryProperties,
  type InternalTelemetryEvent,
  type TelemetryOrigin,
} from '@relaycast/types';
import { flushAllPostHogClients, getPostHogClient, telemetryEnabled } from './posthog.js';
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

/**
 * Split the `origin_actor` path into discrete PostHog dimensions so server
 * events can be segmented by app / actor type / harness / version / model
 * without re-parsing the string at query time. The wire/SDK only ever sends one
 * `origin_actor` string; this cloud-side split is the only place it's
 * interpreted. See `cloud/plans/origin-actor.md`.
 *
 *   {app}/{type}[/{name}]   where  name = {harness}[@{version}[-{model}]]
 *   agent-relay-cli/agent/claude-code@2.3.1-opus4.8   (version + model)
 *   agent-relay-cli/agent/claude-code@opus4.8          (model only)
 *   agent-relay-cli/agent/claude-code@2.3.1            (version only)
 *
 * The `@`-suffix (meta) is `{version}-{model}`. Producers don't always know the
 * harness version, so meta can also be a bare model. We disambiguate by shape:
 * a version starts with a digit (`2.3.1`); a meta that doesn't is treated as a
 * model. (Model ids conventionally start with a provider letter — `opus4.8`,
 * `gpt-5`, `claude-3-5-sonnet`.) Missing parts are omitted (no empty props).
 */
export function deriveOriginActorProps(originActor: unknown): Record<string, string> {
  if (typeof originActor !== 'string' || originActor.trim() === '') return {};
  const [app, type, ...rest] = originActor.split('/');
  // Tolerate stray slashes in the name slot rather than dropping them.
  const nameMeta = rest.join('/');
  const at = nameMeta.indexOf('@');
  const name = at >= 0 ? nameMeta.slice(0, at) : nameMeta;
  const meta = at >= 0 ? nameMeta.slice(at + 1) : '';
  let version = '';
  let model = '';
  if (meta) {
    if (/^\d/.test(meta)) {
      // {version}[-{model}] — version first (model may itself contain `-`).
      const dash = meta.indexOf('-');
      version = dash >= 0 ? meta.slice(0, dash) : meta;
      model = dash >= 0 ? meta.slice(dash + 1) : '';
    } else {
      // No leading digit → model only (no version).
      model = meta;
    }
  }
  return {
    ...(app ? { origin_app: app } : {}),
    ...(type ? { origin_actor_type: type } : {}),
    ...(name ? { origin_actor_name: name } : {}),
    ...(version ? { origin_actor_version: version } : {}),
    ...(model ? { origin_actor_model: model } : {}),
  };
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
      ...deriveOriginActorProps((event.properties as Record<string, unknown>).origin_actor),
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
  await flushAllPostHogClients();
}
