import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { files } from '../../db/schema.js';
import { isContainedStorageKey, signFileToken, verifyFileToken } from '../../lib/fileTokens.js';
import { createWorkspace, makeNodeStack, registerAgent } from './harness.js';

describe('file storage keys', () => {
  it('never contain the client filename', async () => {
    const stack = makeNodeStack();
    const workspace = await createWorkspace(stack.app, 'key-containment');
    const agent = await registerAgent(stack.app, workspace.workspaceKey, 'uploader');
    const res = await stack.app.request('/v1/files/upload', {
      method: 'POST',
      headers: { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ filename: '../../victim/123/evil.txt', content_type: 'text/plain', size_bytes: 4 }),
    });
    expect(res.status).toBe(201);
    const { data } = await res.json() as { data: { id: string } };

    const [row] = await stack.runtime.deps.db.select().from(files).where(eq(files.id, data.id));
    expect(row.filename).toBe('../../victim/123/evil.txt');
    expect(row.storageKey).toBe(`${workspace.workspaceId}/${data.id}/${data.id}.txt`);
    expect(isContainedStorageKey(row.storageKey)).toBe(true);
  });

  it('store a long non-ASCII filename on local disk under a bounded name', async () => {
    const stack = makeNodeStack();
    const workspace = await createWorkspace(stack.app, 'long-name');
    const agent = await registerAgent(stack.app, workspace.workspaceKey, 'uploader');
    const filename = `${'漢字'.repeat(60)}.txt`;
    const headers = { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' };
    const res = await stack.app.request('/v1/files/upload', {
      method: 'POST',
      headers,
      body: JSON.stringify({ filename, content_type: 'text/plain', size_bytes: 5 }),
    });
    expect(res.status).toBe(201);
    const { data } = await res.json() as { data: { id: string; upload_url: string } };
    const put = await stack.runtime.fileHandler(new Request(data.upload_url, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'hello',
    }));
    expect(put.status).toBe(200);
    const complete = await stack.app.request(`/v1/files/${data.id}/complete`, { method: 'POST', headers, body: '{}' });
    expect(complete.status).toBe(200);
    const [row] = await stack.runtime.deps.db.select().from(files).where(eq(files.id, data.id));
    expect(row.filename).toBe(filename);
    expect(row.storageKey).toBe(`${workspace.workspaceId}/${data.id}/${data.id}.txt`);
  });

  it('are refused by file tokens when they would leave their prefix', async () => {
    for (const key of ['w/f/../../x/f/a', 'w/../x', 'w/f/..', 'w/f/a/b', 'w/f/', 'w\\f\\a', '../w/f']) {
      expect(isContainedStorageKey(key)).toBe(false);
      await expect(signFileToken('s', { key, op: 'get', exp: Math.floor(Date.now() / 1000) + 60 })).rejects.toThrow();
    }
    // A token minted before this check (or forged with the secret) still fails verification.
    const body = btoa(JSON.stringify({ key: 'w/f/../../x/f/a', op: 'get', exp: Math.floor(Date.now() / 1000) + 60 }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('s'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
    const token = `${body}.${btoa(String.fromCharCode(...mac)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
    expect(await verifyFileToken('s', token)).toBeNull();
    expect(await verifyFileToken('s', await signFileToken('s', { key: 'w/f/a.txt', op: 'get', exp: Math.floor(Date.now() / 1000) + 60 })))
      .toMatchObject({ key: 'w/f/a.txt' });
  });
});

describe('file upload sizes', () => {
  it('must be positive safe integers within the deployment limit', async () => {
    const stack = makeNodeStack({ maxUploadBytes: 1024 });
    const workspace = await createWorkspace(stack.app, 'upload-sizes');
    const agent = await registerAgent(stack.app, workspace.workspaceKey, 'uploader');
    const upload = async (size: unknown) => {
      const res = await stack.app.request('/v1/files/upload', {
        method: 'POST',
        headers: { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'a.txt', content_type: 'text/plain', ...(size === undefined ? {} : { size_bytes: size }) }),
      });
      return { status: res.status, body: await res.json() as { error?: { code: string; message: string } } };
    };
    expect((await upload(undefined)).body.error?.message).toBe('size_bytes is required');
    for (const size of [-1, 0, 1.5, 2 ** 60]) {
      const result = await upload(size);
      expect(result.status).toBe(400);
      expect(result.body.error?.message).toBe('size_bytes must be a positive integer');
    }
    const tooLarge = await upload(1025);
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body.error?.code).toBe('file_too_large');
    expect((await upload(1024)).status).toBe(201);
  });
});
