import { describe, expect, it } from 'vitest';
import {
  RelayError,
  normalizeRelayErrorCode,
  relayErrorRetryable,
  relayErrorFromApi,
} from '../errors.js';

describe('RelayError', () => {
  it('stores code, message, and statusCode', () => {
    const err = new RelayError('name_conflict', 'Agent already exists', { statusCode: 409 });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('RelayError');
    expect(err.code).toBe('name_conflict');
    expect(err.message).toBe('Agent already exists');
    expect(err.statusCode).toBe(409);
    expect(err.status).toBe(409);
  });

  it('defaults retryable from code + statusCode', () => {
    const conflict = new RelayError('name_conflict', 'conflict', { statusCode: 409 });
    expect(conflict.retryable).toBe(false);

    const transport = new RelayError('transport_error', 'network', { statusCode: 500 });
    expect(transport.retryable).toBe(true);

    const notFound = new RelayError('not_found', 'missing', { statusCode: 404 });
    expect(notFound.retryable).toBe(false);
  });

  it('allows retryable override', () => {
    const err = new RelayError('name_conflict', 'conflict', { statusCode: 409, retryable: true });
    expect(err.retryable).toBe(true);
  });

  it('stores rawCode', () => {
    const err = new RelayError('name_conflict', 'exists', { statusCode: 409, rawCode: 'agent_already_exists' });
    expect(err.rawCode).toBe('agent_already_exists');
  });

  it('stores cause', () => {
    const cause = new Error('network');
    const err = new RelayError('transport_error', 'failed', { cause });
    expect((err as unknown as { cause: Error }).cause).toBe(cause);
  });

  it('defaults status to 0 when no statusCode', () => {
    const err = new RelayError('transport_error', 'failed');
    expect(err.status).toBe(0);
    expect(err.statusCode).toBeUndefined();
  });
});

describe('normalizeRelayErrorCode', () => {
  it('maps agent_already_exists to name_conflict', () => {
    expect(normalizeRelayErrorCode('agent_already_exists')).toBe('name_conflict');
  });

  it('maps name_conflict to name_conflict', () => {
    expect(normalizeRelayErrorCode('name_conflict')).toBe('name_conflict');
  });

  it('maps agent_not_found to not_found', () => {
    expect(normalizeRelayErrorCode('agent_not_found')).toBe('not_found');
  });

  it('maps rate_limit_exceeded to rate_limited', () => {
    expect(normalizeRelayErrorCode('rate_limit_exceeded')).toBe('rate_limited');
  });

  it('maps backpressure to backpressure', () => {
    expect(normalizeRelayErrorCode('backpressure')).toBe('backpressure');
  });

  it('maps queue_overloaded to backpressure', () => {
    expect(normalizeRelayErrorCode('queue_overloaded')).toBe('backpressure');
  });

  it('maps workspace_stream_backpressure to backpressure', () => {
    expect(normalizeRelayErrorCode('workspace_stream_backpressure')).toBe('backpressure');
  });

  it('maps not_found to not_found', () => {
    expect(normalizeRelayErrorCode('not_found')).toBe('not_found');
  });

  it('maps unauthorized to unauthorized', () => {
    expect(normalizeRelayErrorCode('unauthorized')).toBe('unauthorized');
  });

  it('maps workspace_mismatch to workspace_mismatch', () => {
    expect(normalizeRelayErrorCode('workspace_mismatch')).toBe('workspace_mismatch');
  });

  it('maps workspace_not_found to workspace_mismatch', () => {
    expect(normalizeRelayErrorCode('workspace_not_found')).toBe('workspace_mismatch');
  });

  it('falls back to statusCode-based mapping for 401', () => {
    expect(normalizeRelayErrorCode('unknown_code', 401)).toBe('unauthorized');
  });

  it('falls back to statusCode-based mapping for 403', () => {
    expect(normalizeRelayErrorCode('unknown_code', 403)).toBe('unauthorized');
  });

  it('falls back to statusCode-based mapping for 404', () => {
    expect(normalizeRelayErrorCode('unknown_code', 404)).toBe('not_found');
  });

  it('falls back to statusCode-based mapping for 429', () => {
    expect(normalizeRelayErrorCode('unknown_code', 429)).toBe('rate_limited');
  });

  it('falls back to statusCode-based mapping for 409', () => {
    expect(normalizeRelayErrorCode('unknown_code', 409)).toBe('name_conflict');
  });

  it('falls back to transport_error for unknown codes', () => {
    expect(normalizeRelayErrorCode('random_code', 500)).toBe('transport_error');
  });

  it('falls back to transport_error for undefined rawCode', () => {
    expect(normalizeRelayErrorCode(undefined)).toBe('transport_error');
  });

  it('is case-insensitive', () => {
    expect(normalizeRelayErrorCode('Agent_Already_Exists')).toBe('name_conflict');
  });

  it('trims whitespace', () => {
    expect(normalizeRelayErrorCode(' not_found ')).toBe('not_found');
  });
});

describe('relayErrorRetryable', () => {
  it('returns false for name_conflict', () => {
    expect(relayErrorRetryable('name_conflict', 409)).toBe(false);
  });

  it('returns false for not_found', () => {
    expect(relayErrorRetryable('not_found', 404)).toBe(false);
  });

  it('returns false for unauthorized', () => {
    expect(relayErrorRetryable('unauthorized', 401)).toBe(false);
  });

  it('returns true for rate_limited', () => {
    expect(relayErrorRetryable('rate_limited', 429)).toBe(true);
  });

  it('returns true for backpressure', () => {
    expect(relayErrorRetryable('backpressure', 429)).toBe(true);
  });

  it('returns false for workspace_mismatch', () => {
    expect(relayErrorRetryable('workspace_mismatch', 403)).toBe(false);
  });

  it('returns true for transport_error with 5xx', () => {
    expect(relayErrorRetryable('transport_error', 500)).toBe(true);
    expect(relayErrorRetryable('transport_error', 503)).toBe(true);
  });

  it('returns true for transport_error with 408 timeout', () => {
    expect(relayErrorRetryable('transport_error', 408)).toBe(true);
  });

  it('returns true for transport_error with 429 rate limit', () => {
    expect(relayErrorRetryable('transport_error', 429)).toBe(true);
  });

  it('returns false for transport_error with 4xx (non-408/429)', () => {
    expect(relayErrorRetryable('transport_error', 400)).toBe(false);
  });

  it('returns true for transport_error with no statusCode', () => {
    expect(relayErrorRetryable('transport_error')).toBe(true);
  });
});

describe('relayErrorFromApi', () => {
  it('creates a RelayError with normalized code', () => {
    const err = relayErrorFromApi('agent_already_exists', 'exists', 409);
    expect(err).toBeInstanceOf(RelayError);
    expect(err.code).toBe('name_conflict');
    expect(err.rawCode).toBe('agent_already_exists');
    expect(err.statusCode).toBe(409);
    expect(err.message).toBe('exists');
  });

  it('normalizes unknown codes based on statusCode', () => {
    const err = relayErrorFromApi('custom_error', 'not found', 404);
    expect(err.code).toBe('not_found');
  });

  it('maps 429 api errors to rate_limited', () => {
    const err = relayErrorFromApi('rate_limit_exceeded', 'slow down', 429);
    expect(err.code).toBe('rate_limited');
    expect(err.retryable).toBe(true);
  });

  it('defaults to transport_error for completely unknown', () => {
    const err = relayErrorFromApi(undefined, 'oops', 500);
    expect(err.code).toBe('transport_error');
    expect(err.retryable).toBe(true);
  });
});
