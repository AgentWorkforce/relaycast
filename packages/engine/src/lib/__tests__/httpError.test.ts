import type { Context } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { WorkspaceDeliveryCapacityError } from '../../engine/workspaceDeliveryPolicy.js';
import { databaseConstraintKind } from '../../ports/database.js';
import { codedError, errorResponse, safeErrorDiagnostics } from '../httpError.js';

function testContext(): Context {
  const headers = new Headers();
  return {
    header: vi.fn((name: string, value: string) => headers.set(name, value)),
    json: vi.fn((body: unknown, status?: number) =>
      new Response(JSON.stringify(body), { status: status ?? 200, headers }),
    ),
  } as unknown as Context;
}

describe('errorResponse', () => {
  it('maps JSON syntax errors to malformed body responses', async () => {
    const response = errorResponse(testContext(), new SyntaxError('Unexpected end of JSON input'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'invalid_json',
        message: 'Malformed JSON in request body',
      },
    });
  });

  it('preserves coded errors whose message mentions JSON', async () => {
    const response = errorResponse(
      testContext(),
      codedError('No active agents found for skill "JSON"', 'route_not_found', 404),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'route_not_found',
        message: 'No active agents found for skill "JSON"',
      },
    });
  });

  it('does not expose error causes in client responses', async () => {
    const error = codedError('Directory write failed', 'internal_error', 500);
    error.cause = new Error('SQLITE_CONSTRAINT');

    const response = errorResponse(testContext(), error);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message: 'Directory write failed',
      },
    });
  });

  it('does not expose SQL or bound parameters from uncoded server errors', async () => {
    const response = errorResponse(
      testContext(),
      new Error('Failed query: insert into "workspaces" params: rk_live_secret_hash'),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message: 'Internal server error',
      },
    });
  });

  it('treats status 0 as 500 before redacting an uncoded error message', async () => {
    const error = Object.assign(
      new Error('Failed query: insert into "workspaces" params: rk_live_secret_hash'),
      { status: 0 },
    );

    const response = errorResponse(testContext(), error);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message: 'Internal server error',
      },
    });
  });

  it('preserves legacy coded 5xx messages built without codedError', async () => {
    const error = Object.assign(new Error('Service dependency unavailable'), {
      code: 'service_unavailable',
      status: 503,
    });

    const response = errorResponse(testContext(), error);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'service_unavailable',
        message: 'Service dependency unavailable',
      },
    });
  });

  it('keeps only allowlisted primitive diagnostic fields', () => {
    const error = codedError('Storage unavailable', 'storage_unavailable', 503);
    error.diagnostics = {
      attempts: 4,
      operation: 'workspace.create',
      storage_error: 'queue_full',
      api_key_hash: 'must-not-leak',
      query: 'insert into workspaces',
      nested: { params: 'must-not-leak' },
    };

    expect(safeErrorDiagnostics(error)).toEqual({
      attempts: 4,
      operation: 'workspace.create',
      storage_error: 'queue_full',
    });
  });
});

it.each([new WorkspaceDeliveryCapacityError('full'), { code: 'workspace_delivery_depth_exceeded', status: 429, message: 'full' }])('preserves Retry-After for normalized capacity errors', async error => {
  const response = errorResponse(testContext(), error);
  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBe('30');
  expect(await response.json()).toMatchObject({ error: { code: 'workspace_delivery_depth_exceeded' } });
});
it('decodes plain object causes and safely terminates cycles', () => {
  const sentinel = { message: 'D1_ERROR: NOT NULL constraint failed: deliveries.status' };
  expect(databaseConstraintKind(sentinel)).toBe('workspace_delivery_capacity');
  expect(databaseConstraintKind(new Error('wrapper', { cause: sentinel }))).toBe('workspace_delivery_capacity');
  const loop: { cause?: unknown } = {}; loop.cause = loop;
  expect(databaseConstraintKind(loop)).toBeUndefined();
  expect(databaseConstraintKind({ message: 123, cause: { message: 'NOT NULL constraint failed: deliveries.workspace_id' } })).toBe('mailbox_capacity');
});
