import type { Context } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../env.js';
import * as workspaceEngine from '../../engine/workspace.js';
import { codedError } from '../../lib/httpError.js';
import { createWorkspace, makeNodeStack, type TestStack } from './harness.js';

const OVERLOAD = 'D1_ERROR: D1 DB is overloaded. Requests queued for too long.';

/** Fail every prepared statement that inserts into `agents`, as D1 does under load. */
function failAgentInserts(stack: TestStack, message: string): () => void {
  const sqlite = stack.runtime.handle.sqlite;
  const originalPrepare = sqlite.prepare.bind(sqlite);
  sqlite.prepare = ((source: string) => {
    if (/insert into "agents"/i.test(source)) throw new Error(message);
    return originalPrepare(source);
  }) as typeof sqlite.prepare;
  return () => {
    sqlite.prepare = originalPrepare as typeof sqlite.prepare;
  };
}

/**
 * Chain a classifier in front of the engine's own error handler the way the
 * hosted gateway does (relaycast-cloud `installD1OverloadClassifier`): overload
 * answers a retryable 503, everything else goes to the captured engine handler.
 */
function installOverloadClassifier(stack: TestStack): void {
  const app = stack.app;
  const engineHandler = (app as unknown as {
    errorHandler: (err: Error, c: Context<AppEnv>) => Response | Promise<Response>;
  }).errorHandler;
  app.onError((err, c) => {
    if (err.message.includes('D1 DB is overloaded')) {
      return Response.json(
        { ok: false, error: { code: 'database_overloaded', message: 'overloaded' } },
        { status: 503, headers: { 'Retry-After': '2' } },
      );
    }
    return engineHandler(err, c);
  });
}

describe('uncoded server errors in route handlers', () => {
  let stack: TestStack;
  let workspaceKey: string;

  beforeEach(async () => {
    stack = makeNodeStack();
    ({ workspaceKey } = await createWorkspace(stack.app, 'uncoded-errors'));
  });

  afterEach(() => stack.close());

  function registerAgent(name: string): Promise<Response> {
    return Promise.resolve(
      stack.app.request('/v1/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
        body: JSON.stringify({ name }),
      }),
    );
  }

  it('reach the global handler, which logs, records telemetry and returns a request id', async () => {
    const captureException = vi.spyOn(stack.runtime.deps.telemetry, 'captureException');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const restore = failAgentInserts(stack, OVERLOAD);
    try {
      const response = await registerAgent('scratch-agent');

      expect(response.status).toBe(500);
      const body = (await response.json()) as { error: Record<string, unknown> };
      expect(body).toEqual({
        ok: false,
        error: { code: 'internal_error', message: 'Internal server error', request_id: expect.any(String) },
      });
      // The same id rides the header the SDKs read, so clients stop reporting null.
      expect(response.headers.get('x-request-id')).toBe(body.error.request_id);
      expect(captureException).toHaveBeenCalledWith(
        expect.objectContaining({ message: OVERLOAD }),
        expect.objectContaining({
          path: '/v1/agents',
          method: 'POST',
          status_code: 500,
          error_code: 'internal_error',
          request_id: body.error.request_id,
        }),
      );
      expect(errorLog).toHaveBeenCalled();
    } finally {
      restore();
      errorLog.mockRestore();
    }
  });

  it('let a host classifier turn D1 overload into a retryable 503', async () => {
    installOverloadClassifier(stack);
    const restore = failAgentInserts(stack, OVERLOAD);
    try {
      const response = await registerAgent('scratch-agent');

      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('2');
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'database_overloaded' } });
    } finally {
      restore();
    }
  });

  it('still answer coded client errors in the route', async () => {
    installOverloadClassifier(stack);
    const first = await registerAgent('taken-name');
    expect(first.status).toBe(201);

    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await stack.app.request('/v1/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
        body: JSON.stringify({ name: '' }),
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      const body = (await response.json()) as { error: Record<string, unknown> };
      expect(body.error.request_id).toBeUndefined();
      expect(errorLog).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });

  function createSecondWorkspace(): Promise<Response> {
    return Promise.resolve(
      stack.app.request('/v1/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'second-workspace' }),
      }),
    );
  }

  it('capture an uncoded workspace creation failure exactly once, in onError', async () => {
    const captureException = vi.spyOn(stack.runtime.deps.telemetry, 'captureException');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const create = vi.spyOn(workspaceEngine, 'createWorkspace').mockRejectedValue(new Error(OVERLOAD));
    try {
      const response = await createSecondWorkspace();

      expect(response.status).toBe(500);
      expect(captureException).toHaveBeenCalledTimes(1);
      expect(captureException).toHaveBeenCalledWith(
        expect.objectContaining({ message: OVERLOAD }),
        expect.objectContaining({ path: '/v1/workspaces', status_code: 500, error_code: 'internal_error' }),
      );
    } finally {
      create.mockRestore();
      errorLog.mockRestore();
    }
  });

  it('capture a coded workspace creation failure exactly once, in the route', async () => {
    const captureException = vi.spyOn(stack.runtime.deps.telemetry, 'captureException');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const create = vi.spyOn(workspaceEngine, 'createWorkspace').mockRejectedValue(
      codedError('Workspace storage is unavailable', 'storage_unavailable', 503),
    );
    try {
      const response = await createSecondWorkspace();

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: { code: 'storage_unavailable', message: 'Workspace storage is unavailable' },
      });
      expect(captureException).toHaveBeenCalledTimes(1);
      expect(captureException).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'storage_unavailable' }),
        expect.objectContaining({ path: '/v1/workspaces', status_code: 503, error_code: 'storage_unavailable' }),
      );
    } finally {
      create.mockRestore();
      errorLog.mockRestore();
    }
  });
});
