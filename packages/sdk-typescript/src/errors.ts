export type RelayErrorCode =
  | 'name_conflict'
  | 'not_found'
  | 'unauthorized'
  | 'workspace_mismatch'
  | 'transport_error';

export interface RelayErrorOptions {
  statusCode?: number;
  retryable?: boolean;
  rawCode?: string;
  cause?: unknown;
}

const RAW_CODE_MAP: Record<string, RelayErrorCode> = {
  name_conflict: 'name_conflict',
  agent_already_exists: 'name_conflict',
  not_found: 'not_found',
  agent_not_found: 'not_found',
  unauthorized: 'unauthorized',
  workspace_mismatch: 'workspace_mismatch',
  workspace_not_found: 'workspace_mismatch',
};

export function normalizeRelayErrorCode(rawCode: string | undefined, statusCode?: number): RelayErrorCode {
  const normalizedRaw = rawCode?.trim().toLowerCase();
  if (normalizedRaw && RAW_CODE_MAP[normalizedRaw]) {
    return RAW_CODE_MAP[normalizedRaw];
  }

  if (statusCode === 401 || statusCode === 403) {
    return 'unauthorized';
  }

  if (statusCode === 404) {
    return 'not_found';
  }

  if (statusCode === 409) {
    return 'name_conflict';
  }

  return 'transport_error';
}

export function relayErrorRetryable(code: RelayErrorCode, statusCode?: number): boolean {
  if (code !== 'transport_error') {
    return false;
  }

  if (typeof statusCode !== 'number') {
    return true;
  }

  return statusCode >= 500 || statusCode === 408 || statusCode === 429;
}

export class RelayError extends Error {
  readonly code: RelayErrorCode;
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly rawCode?: string;
  readonly status: number;

  constructor(code: RelayErrorCode, message: string, options: RelayErrorOptions = {}) {
    super(message);
    this.name = 'RelayError';
    this.code = code;
    this.statusCode = options.statusCode;
    this.rawCode = options.rawCode;
    this.retryable = options.retryable ?? relayErrorRetryable(code, options.statusCode);
    this.status = options.statusCode ?? 0;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export function relayErrorFromApi(
  rawCode: string | undefined,
  message: string,
  statusCode?: number,
): RelayError {
  const code = normalizeRelayErrorCode(rawCode, statusCode);
  return new RelayError(code, message, { statusCode, rawCode });
}
