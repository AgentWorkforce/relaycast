import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  agents,
  channels,
  fileCleanupQueue,
  files,
  messages,
  workspaceEvents,
  workspaces,
} from '../../db/schema.js';
import { drainFileCleanup, reapExpiredWorkspaces } from '../../engine/workspace.js';
import {
  createWorkspace,
  makeNodeStack,
  registerAgent,
  type TestStack,
} from './harness.js';

async function uploadBlob(stack: TestStack, agentToken: string) {
  const uploadResponse = await stack.app.request('/v1/files/upload', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${agentToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      filename: 'delete-me.txt',
      content_type: 'text/plain',
      size_bytes: 9,
    }),
  });
  expect(uploadResponse.status).toBe(201);
  const uploadBody = await uploadResponse.json() as {
    data: { id: string; upload_url: string };
  };
  const putResponse = await stack.runtime.fileHandler(new Request(uploadBody.data.upload_url, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body: 'delete me',
  }));
  expect(putResponse.status).toBe(200);

  const completeResponse = await stack.app.request(`/v1/files/${uploadBody.data.id}/complete`, {
    method: 'POST',
    headers: { authorization: `Bearer ${agentToken}` },
  });
  expect(completeResponse.status).toBe(200);
  const completeBody = await completeResponse.json() as {
    data: { download_url: string };
  };

  return {
    fileId: uploadBody.data.id,
    downloadUrl: completeBody.data.download_url,
  };
}

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
    await stack.runtime.handle.db.insert(workspaceEvents).values({
      workspaceId: workspace.workspaceId,
      seq: 1,
      type: 'message.created',
      payload: JSON.stringify({ text: 'delete this event payload' }),
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
    expect(await stack.runtime.handle.db.select().from(workspaceEvents)).toHaveLength(0);
  });

  it('removes stored bytes so an issued download URL stops working', async () => {
    const workspace = await createWorkspace(stack.app, 'delete-file-bytes');
    const agent = await registerAgent(stack.app, workspace.workspaceKey, 'uploader');
    const blob = await uploadBlob(stack, agent.token);

    const beforeDelete = await stack.runtime.fileHandler(new Request(blob.downloadUrl));
    expect(beforeDelete.status).toBe(200);
    expect(await beforeDelete.text()).toBe('delete me');

    const response = await stack.app.request(`/v1/workspaces/${workspace.workspaceId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${workspace.workspaceKey}` },
    });

    expect(response.status).toBe(204);
    expect(await stack.runtime.handle.db.select().from(files)).toHaveLength(0);
    expect((await stack.runtime.fileHandler(new Request(blob.downloadUrl))).status).toBe(404);
  });

  it('returns a stable 503 before database changes when storage cannot delete objects', async () => {
    const workspace = await createWorkspace(stack.app, 'unsupported-file-cleanup');
    Object.defineProperty(stack.runtime.deps.files, 'deleteObjects', {
      configurable: true,
      value: undefined,
    });

    const response = await stack.app.request(`/v1/workspaces/${workspace.workspaceId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${workspace.workspaceKey}` },
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'file_storage_delete_unsupported',
        message: 'The configured file storage cannot delete workspace objects',
      },
    });
    expect(await stack.runtime.handle.db.select().from(workspaces)).toHaveLength(1);
  });

  it('commits workspace deletion before blob removal and durably retries a storage failure', async () => {
    const workspace = await createWorkspace(stack.app, 'storage-failure');
    const agent = await registerAgent(stack.app, workspace.workspaceKey, 'uploader');
    await stack.runtime.handle.db.insert(files).values({
      id: 'file_storage_failure',
      workspaceId: workspace.workspaceId,
      uploadedBy: agent.agentId,
      filename: 'failure.txt',
      contentType: 'text/plain',
      sizeBytes: 1,
      storageKey: `${workspace.workspaceId}/file_storage_failure/failure.txt`,
      uploadExpiresAt: new Date(Date.now() - 1_000),
      status: 'complete',
    });
    vi.spyOn(stack.runtime.deps.files, 'deleteObjects')
      .mockRejectedValueOnce(new Error('storage unavailable'));

    const response = await stack.app.request(`/v1/workspaces/${workspace.workspaceId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${workspace.workspaceKey}` },
    });

    expect(response.status).toBe(204);
    expect(await stack.runtime.handle.db.select().from(workspaces)).toHaveLength(0);
    expect(await stack.runtime.handle.db.select().from(files)).toHaveLength(0);
    expect(await stack.runtime.handle.db.select().from(fileCleanupQueue)).toMatchObject([
      { attempts: 1, lastError: 'storage unavailable' },
    ]);

    await expect(drainFileCleanup(
      stack.runtime.handle.db,
      stack.runtime.deps.files,
      { now: new Date(Date.now() + 31_000) },
    )).resolves.toBe(1);
    expect(await stack.runtime.handle.db.select().from(fileCleanupQueue)).toHaveLength(0);
  });

  it('rolls back events and cleanup tombstones without touching storage when database deletion fails', async () => {
    const workspace = await createWorkspace(stack.app, 'database-failure');
    const agent = await registerAgent(stack.app, workspace.workspaceKey, 'database-failure-uploader');
    await stack.runtime.handle.db.insert(files).values({
      id: 'file_database_failure',
      workspaceId: workspace.workspaceId,
      uploadedBy: agent.agentId,
      filename: 'retained.txt',
      contentType: 'text/plain',
      sizeBytes: 1,
      storageKey: `${workspace.workspaceId}/file_database_failure/retained.txt`,
      uploadExpiresAt: new Date(Date.now() - 1_000),
      status: 'complete',
    });
    await stack.runtime.handle.db.insert(workspaceEvents).values({
      workspaceId: workspace.workspaceId,
      seq: 1,
      type: 'workspace.test',
      payload: JSON.stringify({ retain: true }),
    });
    stack.runtime.handle.sqlite.exec(`
      CREATE TRIGGER reject_workspace_delete
      BEFORE DELETE ON workspaces
      BEGIN
        SELECT RAISE(ABORT, 'workspace delete rejected');
      END;
    `);
    const deleteObjects = vi.spyOn(stack.runtime.deps.files, 'deleteObjects');

    const response = await stack.app.request(`/v1/workspaces/${workspace.workspaceId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${workspace.workspaceKey}` },
    });

    expect(response.status).toBe(500);
    expect(await stack.runtime.handle.db.select().from(workspaces)).toHaveLength(1);
    expect(await stack.runtime.handle.db.select().from(files)).toHaveLength(1);
    expect(await stack.runtime.handle.db.select().from(workspaceEvents)).toHaveLength(1);
    expect(await stack.runtime.handle.db.select().from(fileCleanupQueue)).toHaveLength(0);
    expect(deleteObjects).not.toHaveBeenCalled();
  });

  it('keeps a cleanup tombstone until a late upload capability expires', async () => {
    const workspace = await createWorkspace(stack.app, 'late-upload');
    const agent = await registerAgent(stack.app, workspace.workspaceKey, 'late-uploader');
    const uploadResponse = await stack.app.request('/v1/files/upload', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${agent.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        filename: 'late.txt',
        content_type: 'text/plain',
        size_bytes: 4,
      }),
    });
    const upload = await uploadResponse.json() as {
      data: { id: string; upload_url: string; expires_at: string };
    };
    const completeResponse = await stack.app.request(`/v1/files/${upload.data.id}/complete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${agent.token}` },
    });
    const complete = await completeResponse.json() as { data: { download_url: string } };

    const response = await stack.app.request(`/v1/workspaces/${workspace.workspaceId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${workspace.workspaceKey}` },
    });

    expect(response.status).toBe(204);
    expect(await stack.runtime.handle.db.select().from(fileCleanupQueue)).toHaveLength(1);

    // A presigned PUT already handed to the client can race after the database
    // commit. The durable tombstone survives this first successful delete.
    const latePut = await stack.runtime.fileHandler(new Request(upload.data.upload_url, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'late',
    }));
    expect(latePut.status).toBe(200);
    expect((await stack.runtime.fileHandler(new Request(complete.data.download_url))).status).toBe(200);

    const afterUploadExpiry = new Date(new Date(upload.data.expires_at).getTime() + 1);
    await expect(drainFileCleanup(
      stack.runtime.handle.db,
      stack.runtime.deps.files,
      { now: afterUploadExpiry },
    )).resolves.toBe(1);
    expect((await stack.runtime.fileHandler(new Request(complete.data.download_url))).status).toBe(404);
    expect(await stack.runtime.handle.db.select().from(fileCleanupQueue)).toHaveLength(0);
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

    const deleted = await reapExpiredWorkspaces(
      stack.runtime.handle.db,
      stack.runtime.deps.files,
      { now },
    );
    const remaining = await stack.runtime.handle.db
      .select({ id: workspaces.id })
      .from(workspaces);

    expect(deleted).toEqual([expired.workspaceId]);
    expect(remaining.map((row) => row.id).sort()).toEqual(
      [persistent.workspaceId, future.workspaceId].sort(),
    );
  });

  it('reaping removes durable events and stored bytes', async () => {
    const workspace = await createWorkspace(stack.app, 'reap-file-bytes');
    const agent = await registerAgent(stack.app, workspace.workspaceKey, 'uploader');
    const blob = await uploadBlob(stack, agent.token);
    const now = new Date();
    await stack.runtime.handle.db
      .update(workspaces)
      .set({ expiresAt: new Date(now.getTime() - 1_000) })
      .where(eq(workspaces.id, workspace.workspaceId));
    await stack.runtime.handle.db.insert(workspaceEvents).values({
      workspaceId: workspace.workspaceId,
      seq: 999,
      type: 'file.uploaded',
      payload: JSON.stringify({ file_id: blob.fileId }),
    });

    const deleted = await reapExpiredWorkspaces(
      stack.runtime.handle.db,
      stack.runtime.deps.files,
      { now },
    );

    expect(deleted).toEqual([workspace.workspaceId]);
    expect(await stack.runtime.handle.db.select().from(workspaceEvents)).toHaveLength(0);
    expect((await stack.runtime.fileHandler(new Request(blob.downloadUrl))).status).toBe(404);
  });

  it('normalizes non-finite and fractional reap limits before querying', async () => {
    const first = await createWorkspace(stack.app, 'limit-first');
    const second = await createWorkspace(stack.app, 'limit-second');
    const now = new Date();
    await stack.runtime.handle.db
      .update(workspaces)
      .set({ expiresAt: new Date(now.getTime() - 1_000) });

    await expect(reapExpiredWorkspaces(
      stack.runtime.handle.db,
      stack.runtime.deps.files,
      { now, limit: Number.NaN },
    )).resolves.toEqual(expect.arrayContaining([first.workspaceId, second.workspaceId]));

    const third = await createWorkspace(stack.app, 'limit-third');
    const fourth = await createWorkspace(stack.app, 'limit-fourth');
    await stack.runtime.handle.db
      .update(workspaces)
      .set({ expiresAt: new Date(now.getTime() - 1_000) });
    const fractionallyLimited = await reapExpiredWorkspaces(
      stack.runtime.handle.db,
      stack.runtime.deps.files,
      { now, limit: 1.8 },
    );

    expect(fractionallyLimited).toHaveLength(1);
    expect([third.workspaceId, fourth.workspaceId]).toContain(fractionallyLimited[0]);
  });

  it('does not reuse an expired workspace during an authenticated retry', async () => {
    const expired = await createWorkspace(stack.app, 'expired-retry');
    await stack.runtime.handle.db
      .update(workspaces)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(workspaces.id, expired.workspaceId));

    const response = await stack.app.request('/v1/workspaces', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${expired.workspaceKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'expired-retry' }),
    });
    const body = await response.json() as { data: { workspace_id: string } };

    expect(response.status).toBe(201);
    expect(body.data.workspace_id).not.toBe(expired.workspaceId);
    expect(await stack.runtime.handle.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, body.data.workspace_id))).toHaveLength(1);
  });

  it('does not schedule a reap for an idempotent create hit', async () => {
    const persistent = await createWorkspace(stack.app, 'dedupe-hit');
    const expired = await createWorkspace(stack.app, 'expired-bystander');
    await stack.runtime.handle.db
      .update(workspaces)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(workspaces.id, expired.workspaceId));

    const response = await stack.app.request('/v1/workspaces', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${persistent.workspaceKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'dedupe-hit' }),
    });

    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await stack.runtime.handle.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, expired.workspaceId))).toHaveLength(1);
  });

  it('accounts for every workspace_id table and enables foreign-key enforcement', () => {
    const coverage = stack.runtime.handle.sqlite.prepare(`
      SELECT schema_table.name AS table_name,
             (
               SELECT foreign_key.on_delete
               FROM pragma_foreign_key_list(schema_table.name) AS foreign_key
               WHERE foreign_key."table" = 'workspaces'
                 AND foreign_key."from" = 'workspace_id'
             ) AS on_delete
      FROM sqlite_schema AS schema_table
      JOIN pragma_table_info(schema_table.name) AS column
        ON column.name = 'workspace_id'
      WHERE schema_table.type = 'table'
      ORDER BY schema_table.name
    `).all() as Array<{ table_name: string; on_delete: string | null }>;
    const withoutDirectCascade = coverage.filter((table) => table.on_delete !== 'CASCADE');

    expect(stack.runtime.handle.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(coverage).toHaveLength(29);
    expect(withoutDirectCascade).toEqual([
      { table_name: 'workspace_events', on_delete: null },
    ]);
  });
});
