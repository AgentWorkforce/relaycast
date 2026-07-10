import { nangoProxy, type NangoProxyResponse } from "../nango.js";
import type {
  DispatchMetadata,
  DispatchResult,
  IntegrationCredential,
  ProviderDispatchOptions,
  WritebackEnv,
  WritebackProvider,
} from "../types.js";

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429]);

export type AdapterProxyRequest = {
  action?: string;
  method: string;
  endpoint: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  body?: unknown;
};

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS_CODES.has(status) || status >= 500;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function sanitizeText(value: unknown): string {
  const base =
    typeof value === "string"
      ? value
      : value instanceof Error
        ? value.message
        : String(value);

  return base
    .replace(
      /authorization\s*:\s*bearer\s+[^\s"']+/gi,
      "Authorization: Bearer [REDACTED]",
    )
    .replace(/bearer\s+[A-Za-z0-9._~\-+/=]+/gi, "Bearer [REDACTED]")
    .replace(/nango[-_a-z0-9]*secret[^\s,;]*/gi, "[REDACTED]")
    .replace(/token[=:]\s*[^\s,;]+/gi, "token=[REDACTED]")
    .slice(0, 500);
}

export function readMessageFromPayload(
  payload: unknown,
  fallback: string,
): string {
  if (typeof payload === "string" && payload.trim().length > 0) {
    return sanitizeText(payload.trim());
  }
  if (!isRecord(payload)) {
    return fallback;
  }
  for (const key of ["message", "error"] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return sanitizeText(value.trim());
    }
  }
  return fallback;
}

export function extractExternalId(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const id = payload.id;
  return typeof id === "string" || typeof id === "number"
    ? String(id)
    : undefined;
}

export function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

export function readNested(
  record: Record<string, unknown>,
  path: string[],
): unknown {
  let value: unknown = record;
  for (const key of path) {
    if (!isRecord(value)) {
      return undefined;
    }
    value = value[key];
  }
  return value;
}

export function success(
  metadata: DispatchMetadata,
  providerObjectId?: string,
): DispatchResult {
  return {
    outcome: "success",
    ...(providerObjectId ? { providerObjectId } : {}),
    metadata,
  };
}

export function retryableFailure(
  error: unknown,
  metadata?: DispatchMetadata,
): DispatchResult {
  return {
    outcome: "retryable_failure",
    error: sanitizeText(error),
    ...(metadata ? { metadata } : {}),
  };
}

export function permanentFailure(
  error: unknown,
  metadata?: DispatchMetadata,
): DispatchResult {
  return {
    outcome: "permanent_failure",
    error: sanitizeText(error),
    ...(metadata ? { metadata } : {}),
  };
}

export async function proxyAdapterRequest<T = unknown>(
  cred: IntegrationCredential,
  request: AdapterProxyRequest,
  env: WritebackEnv,
  options: ProviderDispatchOptions,
): Promise<NangoProxyResponse<T>> {
  return nangoProxy<T>(
    cred,
    {
      method: request.method,
      endpoint: request.endpoint,
      ...(request.baseUrl ? { baseUrl: request.baseUrl } : {}),
      ...(request.headers ? { headers: request.headers } : {}),
      ...(request.body === undefined ? {} : { data: request.body }),
    },
    env,
    options,
  );
}

export async function dispatchStandardRequest(
  provider: WritebackProvider,
  cred: IntegrationCredential,
  request: AdapterProxyRequest,
  env: WritebackEnv,
  options: ProviderDispatchOptions = {},
): Promise<DispatchResult> {
  const metadata: DispatchMetadata = {
    provider,
    action: request.action,
    method: request.method,
    endpoint: request.endpoint,
  };
  try {
    const response = await proxyAdapterRequest<Record<string, unknown>>(
      cred,
      request,
      env,
      options,
    );
    const externalId = extractExternalId(response.data);
    const responseMetadata = {
      ...metadata,
      status: response.status,
      ...(externalId ? { externalId } : {}),
    };
    if (response.ok) {
      return success(responseMetadata, externalId);
    }
    const message = readMessageFromPayload(
      response.data,
      `${provider} writeback failed with status ${response.status}`,
    );
    return isRetryableStatus(response.status)
      ? retryableFailure(message, responseMetadata)
      : permanentFailure(message, responseMetadata);
  } catch (error) {
    return retryableFailure(error, metadata);
  }
}
