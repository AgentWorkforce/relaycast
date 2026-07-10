import { isWorkerRuntime } from "@/lib/aws/runtime";
import { readDbRuntimeDiagnosticSnapshot } from "@/lib/db";

const cloudflareContextSymbol = Symbol.for("__cloudflare-context__");
const nangoDbWorkspaceDiagnosticLoggedKeys = new WeakMap<object, Set<string>>();
const nangoDbWorkspaceDiagnosticNoContextToken = {};

type NangoDbWorkspaceDiagnosticInput = {
  callsite: string;
  phase: "query" | "handler";
  error: unknown;
  provider?: string | null;
  connectionId?: string | null;
  providerConfigKey?: string | null;
  workspaceId?: string | null;
  syncName?: string | null;
};

// TEMP DIAGNOSTIC (diag/nango-db-workspace) -- REVERT after root-cause.
export function logNangoDbWorkspaceDiagnostic(
  input: NangoDbWorkspaceDiagnosticInput,
): void {
  try {
    const context = (globalThis as Record<symbol, unknown>)[
      cloudflareContextSymbol
    ];
    const token =
      context && typeof context === "object"
        ? (context as object)
        : nangoDbWorkspaceDiagnosticNoContextToken;
    const dedupeKey = `${input.callsite}:${input.phase}`;
    const loggedKeys = nangoDbWorkspaceDiagnosticLoggedKeys.get(token);
    if (loggedKeys?.has(dedupeKey)) {
      return;
    }
    if (loggedKeys) {
      loggedKeys.add(dedupeKey);
    } else {
      nangoDbWorkspaceDiagnosticLoggedKeys.set(token, new Set([dedupeKey]));
    }

    console.info("[diag/nango-db-workspace]", {
      area: "diag/nango-db-workspace",
      tag: "nango-db-workspace",
      callsite: input.callsite,
      phase: input.phase,
      provider: input.provider ?? null,
      connectionId: input.connectionId ?? null,
      providerConfigKey: input.providerConfigKey ?? null,
      workspaceId: input.workspaceId ?? null,
      syncName: input.syncName ?? null,
      navigatorUserAgent: readNavigatorUserAgent(),
      isWorkerRuntime: safeIsWorkerRuntime(),
      cloudflareContextType: typeof context,
      cloudflareContextHasEnv: hasObjectEnv(context),
      cloudflareContextEnvKeys: countContextEnvKeys(context),
      // DB connectivity now lives in webDbRuntime (Neon connection string +
      // selected driver). The old HYPERDRIVE binding probes were removed with
      // the move off Aurora/Hyperdrive.
      webDbRuntime: readDbRuntimeDiagnosticSnapshot() ?? null,
      error: serializeErrorForDiagnostic(input.error),
    });
  } catch {
    // Diagnostic logging must never affect webhook handling.
  }
}

function safeIsWorkerRuntime(): boolean | null {
  try {
    return isWorkerRuntime();
  } catch {
    return null;
  }
}

function readNavigatorUserAgent(): string | null {
  const navigatorLike = (globalThis as { navigator?: { userAgent?: unknown } })
    .navigator;
  return typeof navigatorLike?.userAgent === "string"
    ? navigatorLike.userAgent
    : null;
}

function hasObjectEnv(context: unknown): boolean {
  return (
    !!context &&
    typeof context === "object" &&
    !!(context as { env?: unknown }).env &&
    typeof (context as { env?: unknown }).env === "object"
  );
}

function countContextEnvKeys(context: unknown): number {
  if (!hasObjectEnv(context)) {
    return 0;
  }
  return Object.keys((context as { env: Record<string, unknown> }).env).length;
}

function serializeErrorForDiagnostic(error: unknown): Record<string, unknown> {
  return {
    chain: serializeErrorChain(error),
  };
}

function serializeErrorChain(error: unknown): Array<Record<string, unknown>> {
  const chain: Array<Record<string, unknown>> = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    chain.push(serializeErrorFrame(current));
    current = (current as { cause?: unknown }).cause;
  }
  if (chain.length === 0) {
    chain.push({
      type: typeof error,
      message: String(error),
    });
  }
  return chain.slice(0, 6);
}

function serializeErrorFrame(error: object): Record<string, unknown> {
  const record = error as Record<string, unknown>;
  return {
    name: typeof record.name === "string" ? record.name : null,
    message: redactDiagnosticString(
      typeof record.message === "string" ? record.message : String(error),
    ),
    code: readStringField(record, "code"),
    detail: readStringField(record, "detail"),
    severity: readStringField(record, "severity"),
    routine: readStringField(record, "routine"),
    schema: readStringField(record, "schema"),
    table: readStringField(record, "table"),
    constraint: readStringField(record, "constraint"),
    causeType: typeof record.cause,
  };
}

function readStringField(
  record: Record<string, unknown>,
  field: string,
): string | null {
  const value = record[field];
  return typeof value === "string" && value.length > 0
    ? redactDiagnosticString(value)
    : null;
}

function redactDiagnosticString(value: string): string {
  return value
    .replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, "[redacted-postgres-url]")
    .replace(/(password=)[^&\s]+/gi, "$1[redacted]")
    .replace(/(pass=)[^&\s]+/gi, "$1[redacted]");
}
