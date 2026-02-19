/**
 * Logger for Relaycast server
 *
 * - Emits console logs in development (ENVIRONMENT !== 'production')
 * - Sends to PostHog in production only
 * - Tracks app_version and sdk_version in each log
 */

import type { CloudflareBindings } from './env.js';

// SDK version from @relaycast/sdk package (keep in sync with packages/sdk/package.json)
const SDK_VERSION = '0.3.1';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogContext {
  workspaceId?: string;
  agentId?: string;
  requestId?: string;
  route?: string;
  method?: string;
  statusCode?: number;
  durationMs?: number;
  [key: string]: unknown;
}

interface PostHogEvent {
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
  timestamp?: string;
}

/**
 * Send events to PostHog via HTTP API (works in Cloudflare Workers)
 */
async function sendToPostHog(
  apiKey: string,
  host: string,
  events: PostHogEvent[],
): Promise<void> {
  try {
    await fetch(`${host}/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        api_key: apiKey,
        batch: events,
      }),
    });
  } catch {
    // Silently ignore PostHog errors - logging should never break the app
  }
}

/**
 * Create a logger instance bound to Cloudflare bindings
 */
export function createLogger(env: CloudflareBindings) {
  const isProduction = env.ENVIRONMENT === 'production';
  const appVersion = env.APP_SEMVER || env.APP_VERSION || 'unknown';
  const posthogKey = (env as CloudflareBindings & { POSTHOG_API_KEY?: string }).POSTHOG_API_KEY;
  const posthogHost = (env as CloudflareBindings & { POSTHOG_HOST?: string }).POSTHOG_HOST || 'https://us.i.posthog.com';

  // Buffer for batching events
  const eventBuffer: PostHogEvent[] = [];

  function getCommonProperties(): Record<string, unknown> {
    return {
      app_version: appVersion,
      sdk_version: SDK_VERSION,
      environment: env.ENVIRONMENT || 'development',
    };
  }

  function log(level: LogLevel, message: string, context: LogContext = {}): void {
    const timestamp = new Date().toISOString();
    const commonProps = getCommonProperties();

    // Console output in development (or always for errors)
    if (!isProduction || level === 'error') {
      const logData = {
        timestamp,
        level,
        message,
        ...commonProps,
        ...context,
      };

      if (level === 'error') {
        console.error(JSON.stringify(logData));
      } else if (level === 'warn') {
        console.warn(JSON.stringify(logData));
      } else {
        console.log(JSON.stringify(logData));
      }
    }

    // PostHog in production only
    if (isProduction && posthogKey) {
      const distinctId = context.workspaceId || 'server';

      eventBuffer.push({
        event: `server_log_${level}`,
        distinct_id: distinctId,
        timestamp,
        properties: {
          $lib: 'relaycast-server',
          $lib_version: appVersion,
          message,
          ...commonProps,
          ...context,
        },
      });
    }
  }

  return {
    /**
     * Log an informational message
     */
    info(message: string, context: LogContext = {}): void {
      log('info', message, context);
    },

    /**
     * Log a warning message
     */
    warn(message: string, context: LogContext = {}): void {
      log('warn', message, context);
    },

    /**
     * Log an error message
     */
    error(message: string, error?: Error | unknown, context: LogContext = {}): void {
      const errorContext: LogContext = { ...context };

      if (error instanceof Error) {
        errorContext.error_name = error.name;
        errorContext.error_message = error.message;
        errorContext.error_stack = error.stack;
      } else if (error !== undefined) {
        errorContext.error_raw = String(error);
      }

      log('error', message, errorContext);
    },

    /**
     * Log a debug message (only in development)
     */
    debug(message: string, context: LogContext = {}): void {
      if (!isProduction) {
        log('debug', message, context);
      }
    },

    /**
     * Flush buffered events to PostHog
     * Call this at the end of request handling via waitUntil()
     */
    async flush(): Promise<void> {
      if (eventBuffer.length > 0 && posthogKey) {
        const events = [...eventBuffer];
        eventBuffer.length = 0;
        await sendToPostHog(posthogKey, posthogHost, events);
      }
    },

    /**
     * Get the number of buffered events
     */
    get bufferedCount(): number {
      return eventBuffer.length;
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;
