import { PostHog } from "posthog-node";

type LogLevel = "debug" | "info" | "notice" | "warn" | "error";

type LogContext = {
  area?: string;
  route?: string;
  method?: string;
  userId?: string;
  workspaceId?: string;
  runId?: string;
  [key: string]: unknown;
};

type ErrorContext = LogContext & {
  area: string;
};

let client: PostHog | null = null;

function getPostHogClient(): PostHog | null {
  if (client) return client;

  const apiKey = process.env.POSTHOG_KEY ?? process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!apiKey) return null;

  client = new PostHog(apiKey, {
    host: process.env.POSTHOG_HOST ?? process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
  });

  return client;
}

function normalizeError(error: unknown): { message: string; name?: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  return { message: String(error) };
}

async function captureToPostHog(event: string, distinctId: string, properties: Record<string, unknown>): Promise<void> {
  const ph = getPostHogClient();
  if (!ph) return;

  try {
    await ph.captureImmediate({ event, distinctId, properties });
  } catch {
    // Best-effort telemetry only; never break request flow.
  }
}

function emitConsole(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  if (level === "error") {
    console.error(message, context ?? "");
    return;
  }
  if (level === "warn") {
    console.warn(message, context ?? "");
    return;
  }

  console.log(message, context ?? "");
}

export async function log(level: LogLevel, message: string, context?: LogContext): Promise<void> {
  emitConsole(level, message, context);

  await captureToPostHog("server_log", context?.userId ?? context?.workspaceId ?? "server", {
    ...context,
    level,
    message,
  });
}

export async function captureError(error: unknown, context: ErrorContext): Promise<void> {
  const details = normalizeError(error);

  emitConsole("error", details.message, {
    ...context,
    errorName: details.name,
  });

  await captureToPostHog("$exception", context.userId ?? context.workspaceId ?? "server", {
    ...context,
    $exception_message: details.message,
    $exception_type: details.name ?? "Error",
    $exception_list: [
      {
        type: details.name ?? "Error",
        value: details.message,
        stacktrace: details.stack
          ? {
              frames: details.stack.split("\n").map((line) => ({ raw: line.trim() })),
            }
          : undefined,
      },
    ],
  });
}

export const logger = {
  debug: (message: string, context?: LogContext) => log("debug", message, context),
  info: (message: string, context?: LogContext) => log("info", message, context),
  notice: (message: string, context?: LogContext) => log("notice", message, context),
  warn: (message: string, context?: LogContext) => log("warn", message, context),
  error: (message: string, context?: LogContext) => log("error", message, context),
  captureError,
};

export type { LogLevel, LogContext, ErrorContext };
