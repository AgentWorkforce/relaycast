import {
  normalizeTelemetryOrigin,
  parseInternalTelemetryEvent,
  sanitizeTelemetryProperties,
  type InternalTelemetryEvent,
  type TelemetryOrigin,
} from '@relaycast/types';
import type { CloudflareBindings } from '../env.js';

const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';
const DEFAULT_BATCH_MAX_SIZE = 20;
const DEFAULT_BATCH_FLUSH_MS = 250;

export interface InternalTelemetryCaptureInput {
  event: InternalTelemetryEvent['event'];
  distinct_id: string;
  origin: Partial<TelemetryOrigin>;
  properties?: Record<string, unknown>;
}

type BatchedEvent = {
  event: InternalTelemetryEvent;
  resolve: () => void;
};

type BatchState = {
  host: string;
  apiKey: string;
  queue: BatchedEvent[];
  timer?: ReturnType<typeof setTimeout>;
  flushing: boolean;
};

const telemetryBatchStates = new Map<string, BatchState>();

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function telemetryEnabled(env: CloudflareBindings): boolean {
  return !isTruthy(env.DO_NOT_TRACK) && !isTruthy(env.RELAYCAST_TELEMETRY_DISABLED);
}

function getPostHogHost(env: CloudflareBindings): string {
  const configured = env.POSTHOG_HOST ?? DEFAULT_POSTHOG_HOST;
  return configured.endsWith('/') ? configured.slice(0, -1) : configured;
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

function getBatchKey(host: string, apiKey: string): string {
  return `${host}|${apiKey}`;
}

function eventToBatchItem(event: InternalTelemetryEvent): Record<string, unknown> {
  return {
    event: event.event,
    distinct_id: event.distinct_id,
    properties: {
      distinct_id: event.distinct_id,
      ...event.properties,
      origin_surface: event.origin_surface,
      origin_client: event.origin_client,
      origin_version: event.origin_version,
    },
  };
}

async function flushBatchState(stateKey: string): Promise<void> {
  const state = telemetryBatchStates.get(stateKey);
  if (!state || state.flushing || state.queue.length === 0) return;

  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = undefined;
  }

  state.flushing = true;
  const batch = state.queue.splice(0, DEFAULT_BATCH_MAX_SIZE);

  try {
    const response = await fetch(`${state.host}/batch/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: state.apiKey,
        batch: batch.map((item) => eventToBatchItem(item.event)),
      }),
    });
    if (!response.ok) {
      // Best effort only.
    }
  } catch {
    // Best effort only.
  } finally {
    for (const item of batch) item.resolve();
    state.flushing = false;

    if (state.queue.length >= DEFAULT_BATCH_MAX_SIZE) {
      void flushBatchState(stateKey);
      return;
    }

    if (state.queue.length > 0) {
      state.timer = setTimeout(() => {
        state.timer = undefined;
        void flushBatchState(stateKey);
      }, DEFAULT_BATCH_FLUSH_MS);
      return;
    }

    telemetryBatchStates.delete(stateKey);
  }
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
  const payload = {
    api_key: apiKey,
    event: event.event,
    distinct_id: event.distinct_id,
    properties: {
      ...event.properties,
      origin_surface: event.origin_surface,
      origin_client: event.origin_client,
      origin_version: event.origin_version,
    },
  };

  try {
    const response = await fetch(`${getPostHogHost(env)}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      // Best effort only.
    }
  } catch {
    // Best effort only.
  }
}

export async function captureInternalTelemetryBatched(
  env: CloudflareBindings,
  input: InternalTelemetryCaptureInput | InternalTelemetryEvent,
): Promise<void> {
  if (!telemetryEnabled(env)) return;
  const apiKey = env.POSTHOG_API_KEY;
  if (!apiKey) return;

  const event = 'origin' in input
    ? buildInternalTelemetryEvent(input)
    : parseInternalTelemetryEvent(input);
  const host = getPostHogHost(env);
  const key = getBatchKey(host, apiKey);

  let state = telemetryBatchStates.get(key);
  if (!state) {
    state = {
      host,
      apiKey,
      queue: [],
      flushing: false,
    };
    telemetryBatchStates.set(key, state);
  }

  return new Promise<void>((resolve) => {
    state.queue.push({ event, resolve });

    if (state.queue.length >= DEFAULT_BATCH_MAX_SIZE) {
      void flushBatchState(key);
      return;
    }

    if (!state.timer) {
      state.timer = setTimeout(() => {
        state.timer = undefined;
        void flushBatchState(key);
      }, DEFAULT_BATCH_FLUSH_MS);
    }
  });
}

export async function flushInternalTelemetryBatchesForTests(): Promise<void> {
  const keys = [...telemetryBatchStates.keys()];
  await Promise.all(keys.map((key) => flushBatchState(key)));
}
