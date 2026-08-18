import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agents, channels, messages, workspaces } from '../../db/schema.js';
import { reapExpiredWorkspaces } from '../../engine/workspace.js';
import { createWorkspace, makeNodeStack, type TestStack } from './harness.js';

describe('workspace lifecycle', () => {
  let stack: TestStack;

  beforeEach(() => {
    stack = makeNodeStack();
  });

  afterEach(() => {
    stack.close();
  });

  it('stores an explicit expiry only when the creator supplies a TTL', async () => {
    const before = Date.now();
    const ephemeralResponse = await stack.app.request('/v1/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'short-lived', expires_in_seconds: 3_600 }),
    });

    expect(ephemeralResponse.status).toBe(201);
    const ephemeralBody = await ephemeralResponse.json() as {
      data: { workspace_id: string; expires_at: string | null };
    };
    const expiresAt = new Date(ephemeralBody.data.expires_at ?? '').getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 3_599_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 3_601_000);

    const persistent = await createWorkspace(stack.app, 'persistent');
    const [ephemeralRow] = await stack.runtime.handle.db
      .select({ expiresAt: workspaces.expiresAt })
      .from(workspaces)
      .where(eq(workspaces.id, ephemeralBody.data.workspace_id));
    const [persistentRow] = await stack.runtime.handle.db
      .select({ expiresAt: workspaces.expiresAt })
      .from(workspaces)
      .where(eq(workspaces.id, persistent.workspaceId));

    expect(ephemeralRow.expiresAt?.getTime()).toBe(expiresAt);
    expect(persistentRow.expiresAt).toBeNull();
  });

  it.each([0, 59, 2_592_001, 60.5])(
    'rejects invalid expires_in_seconds value %s',
    async (expiresInSeconds) => {
      const response = await stack.app.request('/v1/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'invalid-expiry', expires_in_seconds: expiresInSeconds }),
      });

      expect(response.status).toBe(400);
      expect(await stack.runtime.handle.db.select().from(workspaces)).toHaveLength(0);
    },
  );

  it('deletes the authenticated workspace by id and cascades all child rows', async () => {
    const workspace = await createWorkspace(stack.app, 'delete-me');
    const [general] = await stack.runtime.handle.db
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.workspaceId, workspace.workspaceId));
    await stack.runtime.handle.db.insert(agents).values({
      id: 'agent_delete_me',
      workspaceId: workspace.workspaceId,
      name: 'deleter',
      tokenHash: 'agent_delete_me_hash',
    });
    await stack.runtime.handle.db.insert(messages).values({
      id: 'message_delete_me',
      workspaceId: workspace.workspaceId,
      channelId: general.id,
      agentId: 'agent_delete_me',
      body: 'cascade me',
    });

    const response = await stack.app.request(`/v1/workspaces/${workspace.workspaceId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${workspace.workspaceKey}` },
    });

    expect(response.status).toBe(204);
    expect(await stack.runtime.handle.db.select().from(workspaces)).toHaveLength(0);
    expect(await stack.runtime.handle.db.select().from(channels)).toHaveLength(0);
    expect(await stack.runtime.handle.db.select().from(agents)).toHaveLength(0);
    expect(await stack.runtime.handle.db.select().from(messages)).toHaveLength(0);
  });

  it('does not let one workspace key delete another workspace id', async () => {
    const first = await createWorkspace(stack.app, 'first');
    const second = await createWorkspace(stack.app, 'second');

    const response = await stack.app.request(`/v1/workspaces/${second.workspaceId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${first.workspaceKey}` },
    });

    expect(response.status).toBe(404);
    expect((await response.json()) as object).toMatchObject({
      ok: false,
      error: { code: 'workspace_not_found' },
    });
    expect(await stack.runtime.handle.db.select().from(workspaces)).toHaveLength(2);
  });

  it('requires a workspace key for id-scoped deletion', async () => {
    const workspace = await createWorkspace(stack.app, 'auth-required');

    const response = await stack.app.request(`/v1/workspaces/${workspace.workspaceId}`, {
      method: 'DELETE',
    });

    expect(response.status).toBe(401);
    expect(await stack.runtime.handle.db.select().from(workspaces)).toHaveLength(1);
  });

  it('reaps only explicit expired deadlines, never inferred CI-like candidates', async () => {
    const persistent = await createWorkspace(stack.app, 'relay-deadbeef');
    const expired = await createWorkspace(stack.app, 'explicitly-expired');
    const future = await createWorkspace(stack.app, 'future-expiry');
    const now = new Date();

    await stack.runtime.handle.db
      .update(workspaces)
      .set({ createdAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1_000) })
      .where(eq(workspaces.id, persistent.workspaceId));
    await stack.runtime.handle.db
      .update(workspaces)
      .set({ expiresAt: new Date(now.getTime() - 1_000) })
      .where(eq(workspaces.id, expired.workspaceId));
    await stack.runtime.handle.db
      .update(workspaces)
      .set({ expiresAt: new Date(now.getTime() + 60_000) })
      .where(eq(workspaces.id, future.workspaceId));

    const deleted = await reapExpiredWorkspaces(stack.runtime.handle.db, { now });
    const remaining = await stack.runtime.handle.db
      .select({ id: workspaces.id })
      .from(workspaces);

    expect(deleted).toEqual([expired.workspaceId]);
    expect(remaining.map((row) => row.id).sort()).toEqual(
      [persistent.workspaceId, future.workspaceId].sort(),
    );
  });

  it('keeps every direct workspace foreign key on delete cascade', () => {
    const foreignKeys = stack.runtime.handle.sqlite.prepare(`
      SELECT schema_table.name AS table_name, foreign_key.on_delete AS on_delete
      FROM sqlite_schema AS schema_table,
           pragma_foreign_key_list(schema_table.name) AS foreign_key
      WHERE schema_table.type = 'table'
        AND foreign_key."table" = 'workspaces'
    `).all() as Array<{ table_name: string; on_delete: string }>;

    expect(foreignKeys.length).toBeGreaterThan(0);
    expect(foreignKeys.every((foreignKey) => foreignKey.on_delete === 'CASCADE')).toBe(true);
  });
});
