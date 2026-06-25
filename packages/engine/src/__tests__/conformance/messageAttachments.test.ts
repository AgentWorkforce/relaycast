import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createWorkspace,
  makeNodeStack,
  registerAgent,
  type TestStack,
} from './harness.js';
import { messageAttachments, messages } from '../../db/schema.js';

describe('channel message attachments', () => {
  let stack: TestStack;

  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  async function uploadFile(token: string, filename: string, complete = true): Promise<string> {
    const upload = await stack.app.request('/v1/files/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        filename,
        content_type: 'text/plain',
        size_bytes: 12,
      }),
    });
    expect(upload.status).toBe(201);
    const uploadBody = await upload.json() as { data: { id: string } };

    if (complete) {
      const completeRes = await stack.app.request(`/v1/files/${uploadBody.data.id}/complete`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(completeRes.status).toBe(200);
    }

    return uploadBody.data.id;
  }

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
});
