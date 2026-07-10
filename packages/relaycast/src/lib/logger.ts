import type { Context } from 'hono';
import type { AppEnv, CloudflareBindings } from '../env.js';
import { getPostHogClient, telemetryEnabled } from './posthog.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogFields = Record<string, unknown>;

const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';
const DEFAULT_APP_VERSION = '0.1.0';
const DEFAULT_SDK_VERSION = 'unknown';
const SERVICE_NAME = 'relaycast-server';
const LOGGER_SCOPE = 'relaycast.server.logger';

const SEVERITY_BY_LEVEL: Record<LogLevel, number> = {
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
};

export interface Logger {
  debug: (message: string, fields?: LogFields) => void;
  info: (message: string, fields?: LogFields) => void;
  warn: (message: string, fields?: LogFields) => void;
  error: (message: string, fields?: LogFields) => void;
  flush: () => Promise<void>;
  child: (source: string, fields?: LogFields) => Logger;
}

interface CreateLoggerOptions {
  source: string;
  request?: Request;
  sdkVersion?: string;
  fields?: LogFields;
  state?: LoggerState;
}

interface LoggerState {
  pending: Set<Promise<void>>;
}

function isProduction(env: CloudflareBindings): boolean {
  return env.ENVIRONMENT.toLowerCase() === 'production';
}

function getPostHogHost(env: CloudflareBindings): string {
  const configured = env.POSTHOG_HOST ?? DEFAULT_POSTHOG_HOST;
  return configured.endsWith('/') ? configured.slice(0, -1) : configured;
}

function getAppVersion(env: CloudflareBindings): string {
  return env.APP_SEMVER ?? env.APP_VERSION ?? DEFAULT_APP_VERSION;
}

function getSdkVersion(env: CloudflareBindings, request?: Request, explicit?: string): string {
  if (explicit) return explicit;
  const fromHeader = request?.headers.get('x-sdk-version');
  if (fromHeader) return fromHeader;
  return env.SDK_SEMVER ?? DEFAULT_SDK_VERSION;
}

function toAttributeValue(value: unknown): { stringValue?: string; boolValue?: boolean; intValue?: string; doubleValue?: number } {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') {
    if (Number.isFinite(value) && Number.isInteger(value)) return { intValue: String(value) };
    if (Number.isFinite(value)) return { doubleValue: value };
    return { stringValue: String(value) };
  }
  if (value === null) return { stringValue: 'null' };
  if (value === undefined) return { stringValue: 'undefined' };
  try {
    return { stringValue: JSON.stringify(value) };
  } catch {
    return { stringValue: String(value) };
  }
}

function metadataToAttributes(metadata: LogFields): Array<{ key: string; value: ReturnType<typeof toAttributeValue> }> {
  return Object.entries(metadata).map(([key, value]) => ({
    key,
    value: toAttributeValue(value),
  }));
}

async function sendToPostHog(
  env: CloudflareBindings,
  level: LogLevel,
  message: string,
  metadata: LogFields,
  appVersion: string,
): Promise<void> {
  const apiKey = env.POSTHOG_API_KEY;
  if (!apiKey) return;

  const timestampNanos = `${Date.now()}000000`;
  const payload = {
    resourceLogs: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: SERVICE_NAME } },
          { key: 'service.version', value: { stringValue: appVersion } },
          { key: 'deployment.environment', value: { stringValue: env.ENVIRONMENT } },
        ],
      },
      scopeLogs: [{
        scope: { name: LOGGER_SCOPE, version: appVersion },
        logRecords: [{
          timeUnixNano: timestampNanos,
          observedTimeUnixNano: timestampNanos,
          severityNumber: SEVERITY_BY_LEVEL[level],
          severityText: level.toUpperCase(),
          body: { stringValue: message },
          attributes: metadataToAttributes(metadata),
        }],
      }],
    }],
  };

  try {
    const response = await globalThis.fetch(`${getPostHogHost(env)}/i/v1/logs`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      // Best effort: ignore non-2xx response from logging backend.
    }
  } catch {
    // Best effort: do not fail request handling if log export fails.
  }
}

function writeConsole(level: LogLevel, source: string, message: string, metadata: LogFields): void {
  const line = `[${source}] ${message}`;
  if (level === 'debug') {
    console.debug(line, metadata);
    return;
  }
  if (level === 'info') {
    console.info(line, metadata);
    return;
  }
  if (level === 'warn') {
    console.warn(line, metadata);
    return;
  }
  console.error(line, metadata);
}

export function createLogger(env: CloudflareBindings, options: CreateLoggerOptions): Logger {
  const appVersion = getAppVersion(env);
  const sdkVersion = getSdkVersion(env, options.request, options.sdkVersion);
  const production = isProduction(env);
  const baseFields = options.fields ?? {};
  const state = options.state ?? { pending: new Set<Promise<void>>() };

  const log = (level: LogLevel, message: string, fields: LogFields = {}) => {
    const metadata: LogFields = {
      app_version: appVersion,
      sdk_version: sdkVersion,
      environment: env.ENVIRONMENT,
      source: options.source,
      ...baseFields,
      ...fields,
    };

    if (!production) {
      writeConsole(level, options.source, message, metadata);
      return;
    }

    const promise = sendToPostHog(env, level, message, metadata, appVersion);
    state.pending.add(promise);
    void promise.finally(() => state.pending.delete(promise));
  };

  return {
    debug: (message, fields) => log('debug', message, fields),
    info: (message, fields) => log('info', message, fields),
    warn: (message, fields) => log('warn', message, fields),
    error: (message, fields) => log('error', message, fields),
    flush: async () => {
      if (state.pending.size === 0) return;
      await Promise.allSettled(Array.from(state.pending));
    },
    child: (source, fields = {}) => createLogger(env, {
      source,
      request: options.request,
      sdkVersion: options.sdkVersion,
      fields: { ...baseFields, ...fields },
      state,
    }),
  };
}

export function createRequestLogger(
  c: Context<AppEnv>,
  source: string,
  fields?: LogFields,
): Logger {
  const request = (() => {
    const maybeReq = (c as unknown as { req?: { raw?: unknown } }).req?.raw;
    return maybeReq instanceof Request ? maybeReq : undefined;
  })();

  const contextReq = (c as unknown as { req?: { path?: string; method?: string } }).req;
  const maybeRequestId = (c as unknown as { get?: (key: string) => unknown }).get?.('requestId');
  const requestId = typeof maybeRequestId === 'string' ? maybeRequestId : undefined;

  return createLogger(c.env, {
    source,
    request,
    fields: {
      ...(requestId ? { request_id: requestId } : {}),
      ...(contextReq?.path ? { route: contextReq.path } : {}),
      ...(contextReq?.method ? { method: contextReq.method } : {}),
      ...(fields ?? {}),
    },
  });
}

export function getRequestLogger(
  c: Context<AppEnv>,
  source: string,
  fields?: LogFields,
): Logger {
  const maybeLogger = (c as unknown as { get?: (key: string) => unknown }).get?.('logger');
  if (
    maybeLogger &&
    typeof maybeLogger === 'object' &&
    typeof (maybeLogger as Logger).child === 'function'
  ) {
    return (maybeLogger as Logger).child(source, fields);
  }
  return createRequestLogger(c, source, fields);
}

export function toErrorDetails(error: unknown): { error_name: string; error_message: string; error_stack?: string } {
  if (error instanceof Error) {
    return {
      error_name: error.name,
      error_message: error.message,
      ...(error.stack ? { error_stack: error.stack } : {}),
    };
  }
  return {
    error_name: 'NonError',
    error_message: String(error),
  };
}

/* ------------------------------------------------------------------ */
/*  PostHog Error Tracking — $exception capture                       */
/* ------------------------------------------------------------------ */

interface ExceptionFrame {
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
}

interface ExceptionEntry {
  type: string;
  value: string;
  mechanism?: { type: string; handled: boolean };
  stacktrace?: { frames: ExceptionFrame[] };
}

function parseStackFrames(stack: string): ExceptionFrame[] {
  const frames: ExceptionFrame[] = [];
  for (const line of stack.split('\n')) {
    const match = line.match(/^\s+at\s+(.+?)\s+\((.+):(\d+):(\d+)\)/) ??
                  line.match(/^\s+at\s+(.+):(\d+):(\d+)/);
    if (!match) continue;
    if (match.length === 5) {
      frames.push({
        function: match[1],
        filename: match[2],
        lineno: Number(match[3]),
        colno: Number(match[4]),
        in_app: !match[2].includes('node_modules'),
      });
    } else if (match.length === 4) {
      frames.push({
        filename: match[1],
        lineno: Number(match[2]),
        colno: Number(match[3]),
        in_app: !match[1].includes('node_modules'),
      });
    }
  }
  // PostHog expects frames in caller-first order (outermost first).
  return frames;
}

function buildExceptionList(error: unknown): ExceptionEntry[] {
  if (error instanceof Error) {
    const entry: ExceptionEntry = {
      type: error.name,
      value: error.message,
      mechanism: { type: 'generic', handled: false },
    };
    if (error.stack) {
      entry.stacktrace = { frames: parseStackFrames(error.stack) };
    }
    return [entry];
  }
  return [{ type: 'NonError', value: String(error), mechanism: { type: 'generic', handled: false } }];
}

export interface CaptureExceptionOptions {
  /** Extra properties merged into the PostHog event. */
  properties?: Record<string, unknown>;
  /** Override the distinct_id (defaults to SERVICE_NAME). */
  distinctId?: string;
}

/**
 * Sends a `$exception` event to PostHog Error Tracking via the PostHog SDK.
 *
 * The returned promise resolves after the SDK has flushed the event, so call
 * sites can pass it to `waitUntil` to keep the isolate alive until delivery.
 */
export async function captureException(
  env: CloudflareBindings,
  error: unknown,
  options: CaptureExceptionOptions = {},
): Promise<void> {
  if (!telemetryEnabled(env)) return;
  const apiKey = env.POSTHOG_API_KEY;
  if (!apiKey) return;

  const exceptionList = buildExceptionList(error);
  const client = getPostHogClient(env, apiKey);

  const additionalProperties: Record<string, unknown> = {
    $exception_list: exceptionList,
    $exception_type: exceptionList[0]?.type,
    $exception_message: exceptionList[0]?.value,
    $exception_level: 'error',
    service_name: SERVICE_NAME,
    environment: env.ENVIRONMENT,
    app_version: getAppVersion(env),
    ...(options.properties ?? {}),
  };

  client.captureException(error, options.distinctId ?? SERVICE_NAME, additionalProperties);
  try {
    await client.flush();
  } catch {
    // Best effort — never break request handling for telemetry.
  }
}
