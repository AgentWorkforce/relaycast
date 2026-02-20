import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  parseTelemetryIngestionEvent,
  sanitizeTelemetryProperties,
  type ClientTelemetryEventName,
} from '@relaycast/types';

interface TelemetryState {
  anonymousId: string;
  telemetryDisabled?: boolean;
  firstRunCaptured?: boolean;
}

export interface TelemetryStatus {
  enabled: boolean;
  reason: 'enabled' | 'env_opt_out' | 'user_opt_out';
  envOptOut: boolean;
  userOptOut: boolean;
}

export interface CliTelemetry {
  capture: (event: ClientTelemetryEventName, properties?: Record<string, unknown>) => void;
  captureFirstRunIfNeeded: () => void;
  flush: (timeoutMs?: number) => Promise<void>;
  status: () => TelemetryStatus;
  setEnabled: (enabled: boolean) => TelemetryStatus;
  getAnonymousId: () => string;
}

const TELEMETRY_PATH = path.join(os.homedir(), '.relay', 'telemetry.json');
const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';
const DEFAULT_POSTHOG_PUBLIC_KEY = 'phc_OAqBdey9pESZCcwaen9Fpyz6Ez8QKiMmLOnvFknXzg4';

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function normalizeHost(host: string | undefined): string {
  const value = host?.trim();
  if (!value) return DEFAULT_POSTHOG_HOST;
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function getPosthogHost(): string {
  return normalizeHost(
    process.env.RELAYCAST_POSTHOG_HOST
      ?? process.env.POSTHOG_HOST,
  );
}

function getPosthogApiKey(): string {
  return (
    process.env.RELAYCAST_POSTHOG_API_KEY
    ?? process.env.POSTHOG_API_KEY
    ?? DEFAULT_POSTHOG_PUBLIC_KEY
  );
}

function loadState(): TelemetryState {
  try {
    const raw = fs.readFileSync(TELEMETRY_PATH, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      'anonymousId' in parsed &&
      typeof (parsed as { anonymousId: unknown }).anonymousId === 'string'
    ) {
      return parsed as TelemetryState;
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') {
      // Ignore malformed telemetry files and overwrite with fresh state.
    }
  }

  const state: TelemetryState = { anonymousId: randomUUID() };
  saveState(state);
  return state;
}

function saveState(state: TelemetryState): void {
  try {
    const dir = path.dirname(TELEMETRY_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TELEMETRY_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch {
    // Best-effort persistence: if filesystem is read-only or unavailable,
    // telemetry will still work with in-memory state
  }
}

function getStatus(state: TelemetryState): TelemetryStatus {
  const envOptOut =
    isTruthy(process.env.DO_NOT_TRACK) || isTruthy(process.env.RELAYCAST_TELEMETRY_DISABLED);
  const userOptOut = state.telemetryDisabled === true;

  if (envOptOut) {
    return {
      enabled: false,
      reason: 'env_opt_out',
      envOptOut,
      userOptOut,
    };
  }

  if (userOptOut) {
    return {
      enabled: false,
      reason: 'user_opt_out',
      envOptOut,
      userOptOut,
    };
  }

  return {
    enabled: true,
    reason: 'enabled',
    envOptOut,
    userOptOut,
  };
}

function postJson(
  urlString: string,
  payload: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };

    try {
      const url = new URL(urlString);
      const body = JSON.stringify(payload);
      const client = url.protocol === 'http:' ? http : https;
      const req = client.request(
        {
          hostname: url.hostname,
          port: url.port ? parseInt(url.port, 10) : undefined,
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            ...headers,
          },
        },
        (res) => {
          res.resume();
          res.on('end', finish);
          res.on('error', finish);
        },
      );

      req.on('error', finish);
      req.setTimeout(1000, () => {
        req.destroy();
        finish();
      });
      req.write(body);
      req.end();
    } catch {
      finish();
    }
  });
}

export function createCliTelemetry(cliVersion = 'unknown'): CliTelemetry {
  const state = loadState();
  const posthogHost = getPosthogHost();
  const posthogApiKey = getPosthogApiKey();
  const sessionId = randomUUID();
  const pending = new Set<Promise<void>>();
  const distinctId = process.env.RELAYCAST_TELEMETRY_DISTINCT_ID || state.anonymousId;
  const distinctIdSource = process.env.RELAYCAST_TELEMETRY_DISTINCT_ID
    ? 'env'
    : 'generated';

  const capture = (event: ClientTelemetryEventName, properties: Record<string, unknown> = {}) => {
    const status = getStatus(state);
    if (!status.enabled) return;

    const parsed = parseTelemetryIngestionEvent({
      event,
      distinct_id: distinctId,
      properties: sanitizeTelemetryProperties({
        surface: 'cli',
        cli_version: cliVersion,
        session_id: sessionId,
        node_version: process.version,
        platform: process.platform,
        arch: process.arch,
        distinct_id_source: distinctIdSource,
        ...properties,
      }),
    });

    const payload = {
      api_key: posthogApiKey,
      event: parsed.event,
      distinct_id: parsed.distinct_id,
      properties: {
        ...parsed.properties,
        origin_surface: 'cli',
        origin_client: 'relaycast-cli',
        origin_version: cliVersion,
      },
    };

    const promise = postJson(
      `${posthogHost}/capture/`,
      payload,
      {},
    );
    pending.add(promise);
    void promise.finally(() => pending.delete(promise));
  };

  const captureFirstRunIfNeeded = () => {
    if (state.firstRunCaptured) return;

    const status = getStatus(state);
    if (!status.enabled) return;

    state.firstRunCaptured = true;
    saveState(state);

    capture('relaycast_cli_first_run', {
      install_source: process.env.RELAYCAST_INSTALL_SOURCE ?? 'unknown',
      install_ref: process.env.RELAYCAST_INSTALL_REF ?? null,
      command_count: Math.max(process.argv.length - 2, 0),
    });
  };

  const flush = async (timeoutMs = 300) => {
    const tasks = Array.from(pending);
    if (tasks.length === 0) return;

    await Promise.race([
      Promise.allSettled(tasks).then(() => undefined),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  };

  const setEnabled = (enabled: boolean): TelemetryStatus => {
    state.telemetryDisabled = !enabled;
    saveState(state);
    return getStatus(state);
  };

  return {
    capture,
    captureFirstRunIfNeeded,
    flush,
    status: () => getStatus(state),
    setEnabled,
    getAnonymousId: () => state.anonymousId,
  };
}
