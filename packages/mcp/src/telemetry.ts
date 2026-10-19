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
  missingConsentFile?: boolean;
}

export interface McpTelemetryOptions {
  posthogHost?: string;
  posthogApiKey?: string;
  originClient?: string;
  originVersion?: string;
}

export interface McpTelemetry {
  capture: (event: ClientTelemetryEventName, properties?: Record<string, unknown>) => void;
  flush: (timeoutMs?: number) => Promise<void>;
}

const TELEMETRY_PATH = path.join(os.homedir(), '.relay', 'telemetry.json');
const IDENTITY_PATH = path.join(os.homedir(), '.relay', 'telemetry-identity.json');
const DEFAULT_POSTHOG_HOST = 'https://i.agentrelay.com';

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function telemetryConsentEnabled(state: TelemetryState): boolean {
  if (isTruthy(process.env.DO_NOT_TRACK) || isTruthy(process.env.RELAYCAST_TELEMETRY_DISABLED)) {
    return false;
  }
  if (state.telemetryDisabled === true) return false;
  return true;
}

function normalizeHost(host: string | undefined): string {
  const value = host?.trim();
  if (!value) return DEFAULT_POSTHOG_HOST;
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function getPosthogHost(options: McpTelemetryOptions): string {
  return normalizeHost(
    process.env.RELAYCAST_POSTHOG_HOST
      ?? process.env.POSTHOG_HOST
      ?? options.posthogHost,
  );
}

function getPosthogApiKey(options: McpTelemetryOptions): string {
  // No baked-in default: a missing key disables telemetry rather than writing
  // into the project's production PostHog. Production injects the key via env.
  return (
    process.env.RELAYCAST_POSTHOG_API_KEY
    ?? process.env.POSTHOG_API_KEY
    ?? options.posthogApiKey
    ?? ''
  );
}

function isTelemetryState(value: unknown): value is TelemetryState {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'anonymousId' in value &&
    typeof (value as { anonymousId: unknown }).anonymousId === 'string' &&
    (value as { anonymousId: string }).anonymousId.trim().length > 0 &&
    (!('telemetryDisabled' in value) || typeof (value as { telemetryDisabled: unknown }).telemetryDisabled === 'boolean'),
  );
}

/** Consent is read-only here: identity rotation must never overwrite an opt-out. */
function loadState(anonymousId: string): TelemetryState | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(TELEMETRY_PATH, 'utf8'));
    return isTelemetryState(parsed) ? parsed : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { anonymousId, missingConsentFile: true };
    // Unknown consent is not permission to reuse an older in-memory opt-in.
    return undefined;
  }
}

function loadAnonymousId(fallback: string): { anonymousId: string; missing?: boolean } | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(IDENTITY_PATH, 'utf8'));
    return isTelemetryState(parsed) ? { anonymousId: parsed.anonymousId } : undefined;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { anonymousId: fallback, missing: true } : undefined;
  }
}

function persistAnonymousId(anonymousId: string): boolean {
  const temporaryPath = `${IDENTITY_PATH}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(IDENTITY_PATH), { recursive: true });
    fs.writeFileSync(temporaryPath, JSON.stringify({ anonymousId }) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporaryPath, IDENTITY_PATH);
    return true;
  } catch {
    return false;
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch { /* already renamed or unavailable */ }
  }
}

function runtimePrefersFetch(): boolean {
  return typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair !== 'undefined';
}

async function postJsonWithFetch(
  urlString: string,
  payload: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<void> {
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
        ...headers,
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

function postJsonWithNodeRequest(
  urlString: string,
  payload: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<boolean> {
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
      resolve(false);
    }
  });
}

async function postJson(
  urlString: string,
  payload: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<void> {
  if (runtimePrefersFetch()) {
    await postJsonWithFetch(urlString, payload, headers);
    return;
  }

  const sentWithNodeRequest = await postJsonWithNodeRequest(urlString, payload, headers);
  if (!sentWithNodeRequest) {
    await postJsonWithFetch(urlString, payload, headers);
  }
}

export function createMcpTelemetry(version = 'unknown', options: McpTelemetryOptions = {}): McpTelemetry {
  let state = loadState(randomUUID()) ?? { anonymousId: randomUUID() };
  let hadConsent: boolean | undefined;
  let localGeneration: string | undefined;
  let sessionId = randomUUID();
  const pending = new Set<Promise<void>>();
  const posthogHost = getPosthogHost(options);
  const posthogApiKey = getPosthogApiKey(options);
  const originClient = options.originClient ?? '@relaycast/mcp';
  const originVersion = options.originVersion ?? version;

  const capture = (event: ClientTelemetryEventName, properties: Record<string, unknown> = {}) => {
    const current = loadState(state.anonymousId);
    if (!current) return;
    const consentEnabled = telemetryConsentEnabled(current);
    if (hadConsent !== false && !consentEnabled) {
      localGeneration = randomUUID();
      sessionId = randomUUID();
    }
    const sharedIdentity = loadAnonymousId(current.anonymousId);
    if (!localGeneration && !sharedIdentity) return;
    const anonymousId = localGeneration ?? sharedIdentity!.anonymousId;
    if (anonymousId !== state.anonymousId) sessionId = randomUUID();
    if (!localGeneration && sharedIdentity?.missing && current.missingConsentFile) localGeneration = anonymousId;
    if (localGeneration && persistAnonymousId(localGeneration)) {
      // The shared file becomes authoritative again after successful persistence.
      localGeneration = undefined;
    }
    state = { ...current, anonymousId };
    hadConsent = consentEnabled;
    // Recheck consent after a write: another process may opt out during rotation.
    const latest = loadState(state.anonymousId);
    if (!latest) return;
    if (!telemetryConsentEnabled(latest)) {
      if (hadConsent !== false) {
        localGeneration = randomUUID();
        sessionId = randomUUID();
        // Persist the observed boundary before returning, including process exit.
        if (persistAnonymousId(localGeneration)) localGeneration = undefined;
      }
      hadConsent = false;
      return;
    }
    // Missing configuration is not an opt-out and must not rotate identity.
    if (!consentEnabled || !posthogApiKey.trim()) return;

    const parsed = parseTelemetryIngestionEvent({
      event,
      distinct_id: state.anonymousId,
      properties: sanitizeTelemetryProperties({
        surface: 'mcp',
        mcp_version: version,
        session_id: sessionId,
        node_version: process.version,
        platform: process.platform,
        arch: process.arch,
        ...properties,
      }),
    });

    const payload = {
      api_key: posthogApiKey,
      event: parsed.event,
      distinct_id: parsed.distinct_id,
      properties: {
        ...parsed.properties,
        origin_client: originClient,
        origin_version: originVersion,
        $process_person_profile: false,
        $geoip_disable: true,
        analytics_contract_version: 2,
        emitter: 'relaycast-mcp',
        emitter_version: version,
        identity_source: 'anonymous',
        actor_kind: 'agent',
        is_authenticated: false,
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
