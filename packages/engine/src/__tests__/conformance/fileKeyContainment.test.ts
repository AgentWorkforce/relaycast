import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { files } from '../../db/schema.js';
import { isContainedStorageKey, signFileToken, verifyFileToken } from '../../lib/fileTokens.js';
import { createWorkspace, makeNodeStack, registerAgent } from './harness.js';

describe('file storage keys', () => {
  it('keep a traversal filename inside the uploader workspace and file', async () => {
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
    expect(row.storageKey).toBe(`${workspace.workspaceId}/${data.id}/..%2F..%2Fvictim%2F123%2Fevil.txt`);
    expect(isContainedStorageKey(row.storageKey)).toBe(true);
  });

  it('encode a bare dot-segment filename', async () => {
    const stack = makeNodeStack();
    const workspace = await createWorkspace(stack.app, 'dot-segment');
    const agent = await registerAgent(stack.app, workspace.workspaceKey, 'uploader');
    const res = await stack.app.request('/v1/files/upload', {
      method: 'POST',
      headers: { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ filename: '..', content_type: 'text/plain', size_bytes: 1 }),
    });
    const { data } = await res.json() as { data: { id: string } };
    const [row] = await stack.runtime.deps.db.select().from(files).where(eq(files.id, data.id));
    expect(row.storageKey.endsWith('/%2E%2E')).toBe(true);
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
