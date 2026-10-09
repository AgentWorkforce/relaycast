import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeRuntime } from '../../adapters/node/index.js';
import { createEngine } from '../../engine.js';
import { usageCounterKey } from '../../engine/usage.js';
import { createWorkspace as createWorkspaceRow, getWorkspace } from '../../engine/workspace.js';
import { createWorkspace, makeNodeStack, type TestStack } from './harness.js';

describe('self-host workspace plan', () => {
  let stack: TestStack | undefined;

  afterEach(async () => {
    await stack?.close();
  });

  it('persists selfhost and ignores the free API-call quota', async () => {
    stack = makeNodeStack();
    const ws = await createWorkspace(stack.app, 'selfhost-plan');

    const identity = await stack.app.request('/v1/workspace', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(identity.status).toBe(200);
    await expect(identity.json()).resolves.toMatchObject({
      ok: true,
      data: { plan: 'selfhost' },
    });
    expect(identity.headers.get('X-RateLimit-Limit')).toBe('30000');

    await stack.runtime.deps.kv.put(usageCounterKey(ws.workspaceId, 'api_calls'), '100000');
    const stillOpen = await stack.app.request('/v1/agents', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(stillOpen.status).toBe(200);
  });

  it('treats an explicit undefined default plan as omitted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relaycast-selfhost-plan-'));
    const runtime = createNodeRuntime({
      dbPath: join(dir, 'relaycast.db'),
      baseUrl: 'http://localhost:0',
      migrate: true,
      eventQueue: { pollIntervalMs: 0 },
      presence: { ttlMs: 60_000, sweepIntervalMs: 0 },
      config: { environment: 'test', defaultWorkspacePlan: undefined },
    });
    try {
      const created = await createEngine(runtime.deps).request('/v1/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'undefined-plan' }),
      });
      expect(created.status).toBe(201);
      const { api_key: apiKey } = (await created.json() as { data: { api_key: string } }).data;
      const identity = await createEngine(runtime.deps).request('/v1/workspace', {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(identity.status).toBe(200);
      await expect(identity.json()).resolves.toMatchObject({ data: { plan: 'selfhost' } });
      expect(identity.headers.get('X-RateLimit-Limit')).toBe('30000');
    } finally {
      runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps an explicit free tier on the free quota', async () => {
    stack = makeNodeStack({ defaultWorkspacePlan: 'free' });
    const ws = await createWorkspace(stack.app, 'explicit-free');

    const identity = await stack.app.request('/v1/workspace', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(identity.status).toBe(200);
    await expect(identity.json()).resolves.toMatchObject({ data: { plan: 'free' } });

    await stack.runtime.deps.kv.put(usageCounterKey(ws.workspaceId, 'api_calls'), '100000');
    const blocked = await stack.app.request('/v1/agents', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(blocked.status).toBe(429);
    await expect(blocked.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'plan_limit_exceeded' },
    });
  });

  it('leaves hosted creates that omit a plan on the schema default', async () => {
    stack = makeNodeStack();
    const created = await createWorkspaceRow(stack.runtime.deps.db, 'hosted-default');
    const loaded = await getWorkspace(stack.runtime.deps.db, created.workspace_id);
    expect(loaded?.plan).toBe('free');
  });

  it('rejects an unknown plan', async () => {
    stack = makeNodeStack();
    await expect(createWorkspaceRow(stack.runtime.deps.db, 'bad-plan', { plan: 'nope' as 'free' }))
      .rejects.toMatchObject({ code: 'invalid_workspace_plan' });
  });

  it('keeps an explicit free workspace when a later startup defaults to selfhost', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relaycast-selfhost-plan-'));
    const dbPath = join(dir, 'relaycast.db');
    const base = {
      dbPath,
      baseUrl: 'http://localhost:0',
      migrate: true,
      eventQueue: { pollIntervalMs: 0 },
      presence: { ttlMs: 60_000, sweepIntervalMs: 0 },
    } as const;
    const first = createNodeRuntime({
      ...base,
      config: { environment: 'test', defaultWorkspacePlan: 'free' },
    });
    let firstClosed = false;
    try {
      const created = await createEngine(first.deps).request('/v1/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'stay-free' }),
      });
      expect(created.status).toBe(201);
      const { api_key: apiKey } = (await created.json() as { data: { api_key: string } }).data;
      first.close();
      firstClosed = true;

      const restarted = createNodeRuntime({
        ...base,
        config: { environment: 'test' },
      });
      try {
        const after = await createEngine(restarted.deps).request('/v1/workspace', {
          headers: { authorization: `Bearer ${apiKey}` },
        });
        expect(after.status).toBe(200);
        const afterBody = await after.json() as { data: { id: string; plan: string } };
        expect(afterBody.data.plan).toBe('free');
        await restarted.deps.kv.put(usageCounterKey(afterBody.data.id, 'api_calls'), '100000');
        const blocked = await createEngine(restarted.deps).request('/v1/agents', {
          headers: { authorization: `Bearer ${apiKey}` },
        });
        expect(blocked.status).toBe(429);
        await expect(blocked.json()).resolves.toMatchObject({
          ok: false,
          error: { code: 'plan_limit_exceeded' },
        });
      } finally {
        restarted.close();
      }
    } finally {
      if (!firstClosed) first.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('promotes a free row that predates the upgrade decision', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relaycast-selfhost-plan-'));
    const dbPath = join(dir, 'relaycast.db');
    const base = {
      dbPath,
      baseUrl: 'http://localhost:0',
      migrate: true,
      eventQueue: { pollIntervalMs: 0 },
      presence: { ttlMs: 60_000, sweepIntervalMs: 0 },
    } as const;
    const first = createNodeRuntime({
      ...base,
      config: { environment: 'test', defaultWorkspacePlan: 'free' },
    });
    let firstClosed = false;
    try {
      const created = await createEngine(first.deps).request('/v1/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'upgrade-me' }),
      });
      expect(created.status).toBe(201);
      const { api_key: apiKey } = (await created.json() as { data: { api_key: string } }).data;
      const before = await createEngine(first.deps).request('/v1/workspace', {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      await expect(before.json()).resolves.toMatchObject({ data: { plan: 'free' } });
      // A database written before this decision has free rows and no record.
      first.handle.sqlite.prepare('DELETE FROM node_selfhost_plan_upgrade').run();
      first.close();
      firstClosed = true;

      const restarted = createNodeRuntime({
        ...base,
        config: { environment: 'test' },
      });
      try {
        const after = await createEngine(restarted.deps).request('/v1/workspace', {
          headers: { authorization: `Bearer ${apiKey}` },
        });
        expect(after.status).toBe(200);
        const afterBody = await after.json() as { data: { id: string; plan: string } };
        expect(afterBody.data.plan).toBe('selfhost');
        await restarted.deps.kv.put(usageCounterKey(afterBody.data.id, 'api_calls'), '100000');
        const stillOpen = await createEngine(restarted.deps).request('/v1/agents', {
          headers: { authorization: `Bearer ${apiKey}` },
        });
        expect(stillOpen.status).toBe(200);
      } finally {
        restarted.close();
      }
    } finally {
      if (!firstClosed) first.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
