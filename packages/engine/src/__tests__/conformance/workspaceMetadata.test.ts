import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeNodeStack, registerAgent, type TestStack } from './harness.js';
import { getWorkspace, updateWorkspace, workspaceCreateRequestDigest } from '../../engine/workspace.js';

describe('workspace metadata', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => { stack?.close(); });

  async function create(metadata?: Record<string, unknown>, idempotencyKey?: string) {
    return stack.app.request('/v1/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      body: JSON.stringify({ name: 'metadata-workspace', ...(metadata === undefined ? {} : { metadata }) }),
    });
  }
  async function patch(key: string, updates: Record<string, unknown>) {
    return stack.app.request('/v1/workspace', {
      method: 'PATCH', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(updates),
    });
  }

  it('persists metadata, shallow merges objects, deletes top-level null, and retains other settings', async () => {
    const created = await create({ project: 'relay', obsolete: true, config: { first: 1 } });
    expect(created.status).toBe(201);
    const { data } = await created.json();
    const response = await patch(data.api_key, { name: 'renamed', system_prompt: 'help', metadata: { obsolete: null, config: { second: null }, count: 2 } });
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ name: 'renamed', system_prompt: 'help', metadata: { project: 'relay', config: { second: null }, count: 2 } });
    const read = await stack.app.request('/v1/workspace', { headers: { authorization: `Bearer ${data.api_key}` } });
    expect((await read.json()).data.metadata).toEqual({ project: 'relay', config: { second: null }, count: 2 });
    const unchanged = await patch(data.api_key, { metadata: {} });
    expect((await unchanged.json()).data.metadata).toEqual({ project: 'relay', config: { second: null }, count: 2 });
  });

  it('defaults to empty metadata and supports metadata-only updates', async () => {
    const { data } = await (await create()).json();
    expect((await getWorkspace(stack.runtime.handle.db, data.workspace_id))?.metadata).toEqual({});
    const response = await patch(data.api_key, { metadata: { project: 'new' } });
    expect((await response.json()).data.metadata).toEqual({ project: 'new' });
  });

  it('preserves independent concurrent patches', async () => {
    const { data } = await (await create({ original: true })).json();
    const db = stack.runtime.handle.db;
    await Promise.all(Array.from({ length: 6 }, (_, i) => updateWorkspace(db, data.workspace_id, { metadata: { [`key${i}`]: i } })));
    expect((await getWorkspace(db, data.workspace_id))?.metadata).toEqual({ original: true, ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`key${i}`, i])) });
  });

  it('rejects merged size/key overflow without writing other fields', async () => {
    const metadata = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`key${i}`, i]));
    const { data } = await (await create(metadata)).json();
    const response = await patch(data.api_key, { name: 'must-not-write', metadata: { extra: true } });
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain('100');
    expect((await getWorkspace(stack.runtime.handle.db, data.workspace_id))?.name).toBe('metadata-workspace');
    const deletion = await patch(data.api_key, { metadata: { key0: null, extra: true } });
    expect(deletion.status).toBe(200);
    const { data: big } = await (await create({ first: 'x'.repeat(9000) })).json();
    expect((await patch(big.api_key, { metadata: { second: 'x'.repeat(9000) } })).status).toBe(400);
  });

  it.each([
    { label: 'null', metadata: null },
    { label: 'array', metadata: [] },
    { label: 'secret', metadata: { nested: { accessToken: 'bad' } } },
    { label: 'oversized', metadata: { value: 'x'.repeat(16384) } },
  ])('rejects invalid metadata on both endpoints: $label', async ({ metadata }) => {
    expect((await stack.app.request('/v1/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'invalid', metadata }) })).status).toBe(400);
    const { data } = await (await create()).json();
    expect((await patch(data.api_key, { metadata })).status).toBe(400);
  });

  it('requires a workspace key for metadata updates', async () => {
    const { data } = await (await create()).json();
    const agent = await registerAgent(stack.app, data.api_key, 'reader');
    expect((await patch(agent.token, { metadata: { test: true } })).status).toBe(401);
  });

  it('canonicalizes nested metadata for idempotent replay and conflicts on changed metadata', async () => {
    const key = 'metadata-replay-9f3a7c1e5b8d2f4a6c0e8b2d4f6a8c0e';
    const first = await create({ z: 1, config: { b: 2, a: ['x', 'y'] } }, key);
    expect(first.status).toBe(201);
    const replay = await create({ config: { a: ['x', 'y'], b: 2 }, z: 1 }, key);
    expect(replay.status).toBe(200);
    expect((await replay.json()).data).toEqual((await first.json()).data);
    expect((await create({ z: 2 }, key)).status).toBe(409);
    expect(await workspaceCreateRequestDigest({ name: 'x' })).not.toBe(await workspaceCreateRequestDigest({ name: 'x', metadata: { value: 1 } }));
    expect(await workspaceCreateRequestDigest({ name: 'x', metadata: { order: [1, 2] } })).not.toBe(await workspaceCreateRequestDigest({ name: 'x', metadata: { order: [2, 1] } }));
  });
});
