import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerFeatureTools } from '../tools/features.js';
import { registerMessagingTools } from '../tools/messaging.js';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const UPLOAD_URL = 'https://files.example.test/_relayfiles?token=upload-signature';
const DOWNLOAD_URL = 'https://files.example.test/_relayfiles?token=download-signature';

function createAgentClient() {
  return {
    dm: vi.fn(async () => ({ id: 'dm1' })),
    dms: {
      createGroup: vi.fn(async () => ({ id: 'conv1' })),
      sendMessage: vi.fn(async () => ({ id: 'gdm1' })),
    },
    files: {
      // @relaycast/sdk camelizes response keys.
      upload: vi.fn(async () => ({ id: 'f1', uploadUrl: UPLOAD_URL, expiresAt: '2026-10-08T23:00:00.000Z' })),
      complete: vi.fn(async () => ({
        id: 'f1',
        filename: 'shot.png',
        contentType: 'image/png',
        sizeBytes: PNG_BYTES.byteLength,
        downloadUrl: DOWNLOAD_URL,
      })),
      get: vi.fn(async () => ({
        id: 'f1',
        filename: '../shot.png',
        contentType: 'image/png',
        sizeBytes: PNG_BYTES.byteLength,
        status: 'complete',
        downloadUrl: DOWNLOAD_URL,
      })),
    },
  };
}

async function connect(localFiles: boolean, agentClient: ReturnType<typeof createAgentClient>) {
  const server = new McpServer({ name: 'test', version: '0.1.0' });
  registerFeatureTools(server, () => agentClient as never, { localFiles });
  registerMessagingTools(server, () => agentClient as never);
  const client = new Client({ name: 'test-client', version: '0.1.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  return client;
}

function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}

function errorText(result: unknown): string {
  const r = result as { isError?: boolean; content: Array<{ text: string }> };
  expect(r.isError).toBe(true);
  return r.content.map((c) => c.text).join('\n');
}

describe('file tools', () => {
  let dir: string;
  let agentClient: ReturnType<typeof createAgentClient>;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'relaycast-mcp-files-')));
    agentClient = createAgentClient();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  it('uploads a local file end to end so the returned id is ready to attach', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const file = path.join(dir, 'shot.png');
    await writeFile(file, PNG_BYTES);
    const client = await connect(true, agentClient);

    const result = await client.callTool({ name: 'message.file.upload', arguments: { path: file } });

    expect(agentClient.files.upload).toHaveBeenCalledWith({
      filename: 'shot.png',
      contentType: 'image/png',
      sizeBytes: PNG_BYTES.byteLength,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(UPLOAD_URL);
    expect(init.method).toBe('PUT');
    expect(Buffer.from(init.body as Uint8Array)).toEqual(PNG_BYTES);
    expect(agentClient.files.complete).toHaveBeenCalledWith('f1');
    expect(structured(result)).toMatchObject({ id: 'f1', filename: 'shot.png', status: 'complete' });
  });

  it('uploads inline base64 bytes', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = await connect(true, agentClient);

    await client.callTool({
      name: 'message.file.upload',
      arguments: { filename: 'shot.png', content_base64: PNG_BYTES.toString('base64') },
    });

    expect(agentClient.files.upload).toHaveBeenCalledWith({
      filename: 'shot.png',
      contentType: 'image/png',
      sizeBytes: PNG_BYTES.byteLength,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(UPLOAD_URL);
    expect(init.method).toBe('PUT');
    expect(Buffer.from(init.body as Uint8Array)).toEqual(PNG_BYTES);
    expect(agentClient.files.complete).toHaveBeenCalledWith('f1');
  });

  it('does not complete an upload whose bytes were rejected, and keeps the signature out of the error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('AccessDenied', { status: 403 })));
    const client = await connect(true, agentClient);

    const result = await client.callTool({
      name: 'message.file.upload',
      arguments: { filename: 'shot.png', content_base64: PNG_BYTES.toString('base64') },
    });

    const message = errorText(result);
    expect(message).toContain('HTTP 403');
    expect(message).not.toContain('upload-signature');
    expect(agentClient.files.complete).not.toHaveBeenCalled();
  });

  it('never reads local paths or PUTs bytes when the server is hosted', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const file = path.join(dir, 'secret.txt');
    await writeFile(file, 'do not upload');
    const client = await connect(false, agentClient);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).not.toContain('message.file.download');
    const upload = tools.tools.find((tool) => tool.name === 'message.file.upload');
    const properties = Object.keys((upload?.inputSchema as { properties: object }).properties);
    expect(properties).not.toContain('path');
    expect(properties).not.toContain('content_base64');

    const fromPath = await client.callTool({ name: 'message.file.upload', arguments: { path: file } });
    expect(errorText(fromPath)).toContain('size_bytes');
    const inline = await client.callTool({
      name: 'message.file.upload',
      arguments: { filename: 'shot.png', content_base64: PNG_BYTES.toString('base64') },
    });
    expect(errorText(inline)).toContain('size_bytes');
    expect(agentClient.files.upload).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the metadata-only upload request and points at message.file.complete', async () => {
    const client = await connect(false, agentClient);

    const result = await client.callTool({
      name: 'message.file.upload',
      arguments: { filename: 'shot.png', content_type: 'image/png', size_bytes: 8 },
    });

    expect(agentClient.files.complete).not.toHaveBeenCalled();
    expect(structured(result)).toMatchObject({ id: 'f1', uploadUrl: UPLOAD_URL });
    expect(String(structured(result).next_step)).toContain('message.file.complete');

    await client.callTool({ name: 'message.file.complete', arguments: { file_id: 'f1' } });
    expect(agentClient.files.complete).toHaveBeenCalledWith('f1');
  });

  it('attaches files to direct and group direct messages', async () => {
    const client = await connect(false, agentClient);

    await client.callTool({
      name: 'message.dm.send',
      arguments: { to: 'linux-agent', text: 'see screenshot', attachments: ['f1'] },
    });
    await client.callTool({
      name: 'message.dm.send_group',
      arguments: { participants: ['a', 'b'], text: 'see screenshot', attachments: ['f1'] },
    });

    expect(agentClient.dm).toHaveBeenCalledWith('linux-agent', 'see screenshot', { attachments: ['f1'] });
    expect(agentClient.dms.sendMessage).toHaveBeenCalledWith('conv1', 'see screenshot', { attachments: ['f1'] });
  });

  it('gets a file with its download URL and downloads it to a sanitized local path', async () => {
    const fetchMock = vi.fn(async () => new Response(PNG_BYTES, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = await connect(true, agentClient);

    const info = await client.callTool({ name: 'message.file.get', arguments: { file_id: 'f1' } });
    expect(structured(info)).toMatchObject({ id: 'f1', downloadUrl: DOWNLOAD_URL });

    const result = await client.callTool({ name: 'message.file.download', arguments: { file_id: 'f1', path: dir } });

    expect(fetchMock).toHaveBeenCalledWith(DOWNLOAD_URL);
    const saved = structured(result);
    expect(saved.path).toBe(path.join(dir, 'shot.png'));
    expect(await readFile(saved.path as string)).toEqual(PNG_BYTES);
  });

  it('refuses a download whose bytes exceed the limit even when the record claims it is small', async () => {
    const huge = new Uint8Array(25 * 1024 * 1024 + 1);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(huge);
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { status: 200 })));
    const client = await connect(true, agentClient);

    const result = await client.callTool({ name: 'message.file.download', arguments: { file_id: 'f1', path: dir } });

    expect(errorText(result)).toContain('download limit');
  });
});
