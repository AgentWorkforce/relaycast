import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

interface TelemetryState {
  anonymousId: string;
  telemetryDisabled?: boolean;
}

export interface McpTelemetry {
  capture: (event: string, properties?: Record<string, unknown>) => void;
  flush: (timeoutMs?: number) => Promise<void>;
}

const TELEMETRY_PATH = path.join(os.homedir(), '.relay', 'telemetry.json');
const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';
const DEFAULT_POSTHOG_KEY = 'phc_OAqBdey9pESZCcwaen9Fpyz6Ez8QKiMmLOnvFknXzg4';

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
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
      // Fall through to fresh state.
    }
  }

  const state: TelemetryState = { anonymousId: randomUUID() };
  try {
    const dir = path.dirname(TELEMETRY_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TELEMETRY_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch {
    // Best-effort persistence: if filesystem is read-only or unavailable,
    // telemetry will still work with ephemeral anonymous ID
  }
  return state;
}

function telemetryEnabled(state: TelemetryState): boolean {
  if (isTruthy(process.env.DO_NOT_TRACK) || isTruthy(process.env.RELAYCAST_TELEMETRY_DISABLED)) {
    return false;
  }
  if (state.telemetryDisabled === true) return false;
  return true;
}

function getPostHogHost(): string {
  const configured = process.env.POSTHOG_HOST ??
    process.env.RELAYCAST_POSTHOG_HOST ??
    DEFAULT_POSTHOG_HOST;
  return configured.endsWith('/') ? configured.slice(0, -1) : configured;
}

function getPostHogKey(): string {
  return process.env.POSTHOG_API_KEY ??
    process.env.RELAYCAST_POSTHOG_KEY ??
    process.env.POSTHOG_KEY ??
    DEFAULT_POSTHOG_KEY;
}

function runtimePrefersFetch(): boolean {
  return typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair !== 'undefined';
}

async function postJsonWithFetch(urlString: string, payload: Record<string, unknown>): Promise<void> {
  if (typeof fetch !== 'function') return;

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  const timer = setTimeout(() => controller?.abort(), 1000) as ReturnType<typeof setTimeout> & {
    unref?: () => void;
  };
  timer.unref?.();

  try {
    await fetch(urlString, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller?.signal,
    });
  } catch {
    // Best effort telemetry; swallow send errors.
  } finally {
    clearTimeout(timer);
  }
}

function postJsonWithNodeRequest(urlString: string, payload: Record<string, unknown>): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      resolve(true);
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
      resolve(false);
    }
  });
}

async function postJson(urlString: string, payload: Record<string, unknown>): Promise<void> {
  if (runtimePrefersFetch()) {
    await postJsonWithFetch(urlString, payload);
    return;
  }

  const sentWithNodeRequest = await postJsonWithNodeRequest(urlString, payload);
  if (!sentWithNodeRequest) {
    await postJsonWithFetch(urlString, payload);
  }
}

export function createMcpTelemetry(version = 'unknown'): McpTelemetry {
  const state = loadState();
  const sessionId = randomUUID();
  const pending = new Set<Promise<void>>();
  const distinctId = process.env.RELAYCAST_TELEMETRY_DISTINCT_ID || state.anonymousId;

  const capture = (event: string, properties: Record<string, unknown> = {}) => {
    if (!telemetryEnabled(state)) return;

    const payload = {
      api_key: getPostHogKey(),
      event,
      distinct_id: distinctId,
      properties: {
        surface: 'mcp',
        mcp_version: version,
        session_id: sessionId,
        node_version: process.version,
        platform: process.platform,
        arch: process.arch,
        ...properties,
      },
    };

    const promise = postJson(`${getPostHogHost()}/capture/`, payload);
    pending.add(promise);
    void promise.finally(() => pending.delete(promise));
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

  return { capture, flush };
}
