import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createWorkspace,
  makeNodeStack,
  registerAgent,
  type TestStack,
} from './harness.js';
import { files, messageAttachments, messages } from '../../db/schema.js';

const TEXT_BYTES = new TextEncoder().encode('hello world\n');
// A real (tiny) PNG signature + header so the content round-trips as binary.
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0xff, 0x00,
]);

/**
 * Upload a file the way a real client must: request an upload URL, PUT the
 * bytes to it, then complete. `put: false` skips the byte upload.
 */
async function storeFile(
  stack: TestStack,
  token: string,
  filename: string,
  opts: { complete?: boolean; put?: boolean; bytes?: Uint8Array; contentType?: string } = {},
): Promise<string> {
  const bytes = opts.bytes ?? TEXT_BYTES;
  const contentType = opts.contentType ?? 'text/plain';
  const upload = await stack.app.request('/v1/files/upload', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ filename, content_type: contentType, size_bytes: bytes.byteLength }),
  });
  expect(upload.status).toBe(201);
  const uploadBody = await upload.json() as { data: { id: string; upload_url: string } };

  if (opts.put !== false) {
    const put = await stack.runtime.fileHandler(new Request(uploadBody.data.upload_url, {
      method: 'PUT',
      headers: { 'content-type': contentType },
      body: bytes,
    }));
    expect(put.status).toBe(200);
  }

  if (opts.complete !== false) {
    const completeRes = await stack.app.request(`/v1/files/${uploadBody.data.id}/complete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(completeRes.status).toBe(200);
  }

  return uploadBody.data.id;
}

/** Fetch an attachment's bytes as a recipient would: file record, then its download URL. */
async function downloadAs(stack: TestStack, token: string, fileId: string) {
  const res = await stack.app.request(`/v1/files/${fileId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const file = (await res.json() as {
    data: { filename: string; content_type: string; size_bytes: number; status: string; download_url: string | null };
  }).data;
  expect(file.status).toBe('complete');
  expect(file.download_url).toEqual(expect.any(String));
  const bytesRes = await stack.runtime.fileHandler(new Request(file.download_url!));
  expect(bytesRes.status).toBe(200);
  return {
    file,
    contentType: bytesRes.headers.get('content-type'),
    bytes: new Uint8Array(await bytesRes.arrayBuffer()),
  };
}

describe('channel message attachments', () => {
  let stack: TestStack;

  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  const uploadFile = (token: string, filename: string, complete = true) =>
    storeFile(stack, token, filename, { complete });

  async function postMessage(token: string, attachments: string[]): Promise<Response> {
    return stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: 'see attached', attachments }),
    });
  }

  it('persists complete same-workspace file attachments in caller order', async () => {
    const ws = await createWorkspace(stack.app, 'channel-attachments-valid-ws');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const first = await uploadFile(alice.token, 'first.txt');
    const second = await uploadFile(alice.token, 'second.txt');

    const res = await postMessage(alice.token, [second, first]);
    const body = await res.json() as {
      data: {
        attachments: Array<{
          file_id: string;
          filename: string;
          content_type: string;
          size_bytes: number;
        }>;
      };
    };

    expect(res.status).toBe(201);
    expect(body.data.attachments).toEqual([
      { file_id: second, filename: 'second.txt', content_type: 'text/plain', size_bytes: 12 },
      { file_id: first, filename: 'first.txt', content_type: 'text/plain', size_bytes: 12 },
    ]);

    const attachmentRows = await stack.runtime.deps.db.select().from(messageAttachments);
    expect(attachmentRows.map((row) => row.fileId)).toEqual([second, first]);
  });

  it('rejects missing, incomplete, foreign-workspace, and duplicate file ids', async () => {
    const ws = await createWorkspace(stack.app, 'channel-attachments-invalid-ws');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const pendingFile = await uploadFile(alice.token, 'pending.txt', false);
    const completeFile = await uploadFile(alice.token, 'complete.txt');

    const otherWs = await createWorkspace(stack.app, 'channel-attachments-other-ws');
    const otherAgent = await registerAgent(stack.app, otherWs.workspaceKey, 'other');
    const foreignFile = await uploadFile(otherAgent.token, 'foreign.txt');

    const invalidAttachments = [
      ['file_missing'],
      [pendingFile],
      [foreignFile],
      [completeFile, completeFile],
    ];

    for (const attachments of invalidAttachments) {
      const res = await postMessage(alice.token, attachments);
      const body = await res.json() as { error: { code: string; message: string } };
      expect(res.status).toBe(400);
      expect(body.error).toEqual({
        code: 'invalid_attachments',
        message: attachments.length > 1
          ? 'Invalid attachments: duplicate file ids are not allowed'
          : 'Invalid attachments: file ids must exist in workspace and be complete',
      });
    }

    const messageRows = await stack.runtime.deps.db
      .select()
      .from(messages)
      .where(eq(messages.workspaceId, ws.workspaceId));
    expect(messageRows).toHaveLength(0);
    expect(await stack.runtime.deps.db.select().from(messageAttachments)).toHaveLength(0);
  });

  it('refuses to complete an upload whose bytes were never stored, so it cannot be attached', async () => {
    const ws = await createWorkspace(stack.app, 'channel-attachments-no-bytes-ws');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const fileId = await storeFile(stack, alice.token, 'never-sent.png', { put: false, complete: false });

    const completeRes = await stack.app.request(`/v1/files/${fileId}/complete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alice.token}` },
    });
    const completeBody = await completeRes.json() as { error: { code: string } };
    expect(completeRes.status).toBe(409);
    expect(completeBody.error.code).toBe('upload_incomplete');

    const [row] = await stack.runtime.deps.db.select().from(files).where(eq(files.id, fileId));
    expect(row.status).toBe('pending');

    const res = await postMessage(alice.token, [fileId]);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('invalid_attachments');
  });

  it('records the stored size and lets another channel member download the exact bytes', async () => {
    const ws = await createWorkspace(stack.app, 'channel-attachments-download-ws');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const fileId = await storeFile(stack, alice.token, 'screenshot.png', {
      bytes: PNG_BYTES,
      contentType: 'image/png',
    });

    const res = await postMessage(alice.token, [fileId]);
    expect(res.status).toBe(201);

    const listed = await stack.app.request('/v1/channels/general/messages', {
      headers: { authorization: `Bearer ${bob.token}` },
    });
    const listedBody = await listed.json() as { data: Array<{ attachments: Array<{ file_id: string }> }> };
    expect(listedBody.data.flatMap((message) => message.attachments)).toEqual([
      { file_id: fileId, filename: 'screenshot.png', content_type: 'image/png', size_bytes: PNG_BYTES.byteLength },
    ]);

    const downloaded = await downloadAs(stack, bob.token, fileId);
    expect(downloaded.file.size_bytes).toBe(PNG_BYTES.byteLength);
    expect(downloaded.contentType).toBe('image/png');
    expect(Array.from(downloaded.bytes)).toEqual(Array.from(PNG_BYTES));
  });
});

describe('direct message attachments', () => {
  let stack: TestStack;

  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  it('delivers a DM attachment the recipient can list, receive and download', async () => {
    const ws = await createWorkspace(stack.app, 'dm-attachments-ws');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const fileId = await storeFile(stack, alice.token, 'screenshot.png', {
      bytes: PNG_BYTES,
      contentType: 'image/png',
    });
    const attachment = {
      file_id: fileId,
      filename: 'screenshot.png',
      content_type: 'image/png',
      size_bytes: PNG_BYTES.byteLength,
    };

    const sent = await stack.app.request('/v1/dm', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ to: 'bob', text: 'see screenshot', attachments: [fileId] }),
    });
    expect(sent.status).toBe(201);
    const sentBody = await sent.json() as {
      data: { conversation_id: string; message: { attachments: unknown[] } };
    };
    expect(sentBody.data.message.attachments).toEqual([attachment]);

    const history = await stack.app.request(`/v1/dm/${sentBody.data.conversation_id}/messages`, {
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(history.status).toBe(200);
    const historyBody = await history.json() as { data: Array<{ attachments: unknown[] }> };
    expect(historyBody.data.flatMap((message) => message.attachments)).toEqual([attachment]);

    await stack.settle();
    const deliveries = await stack.app.request('/v1/deliveries', {
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(deliveries.status).toBe(200);
    const queued = (await deliveries.json() as {
      data: Array<{ reason: string; message: { attachments?: unknown[] } | null }>;
    }).data;
    expect(queued.filter((item) => item.reason === 'dm').map((item) => item.message?.attachments)).toEqual([
      [attachment],
    ]);

    const downloaded = await downloadAs(stack, bob.token, fileId);
    expect(Array.from(downloaded.bytes)).toEqual(Array.from(PNG_BYTES));
  });

  it('rejects incomplete DM attachments before writing the DM', async () => {
    const ws = await createWorkspace(stack.app, 'dm-attachments-invalid-ws');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const pending = await storeFile(stack, alice.token, 'pending.png', { put: false, complete: false });

    const sent = await stack.app.request('/v1/dm', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ to: 'bob', text: 'see screenshot', attachments: [pending] }),
    });
    expect(sent.status).toBe(400);
    expect((await sent.json() as { error: { code: string } }).error.code).toBe('invalid_attachments');
    expect(await stack.runtime.deps.db.select().from(messageAttachments)).toHaveLength(0);
  });
});
