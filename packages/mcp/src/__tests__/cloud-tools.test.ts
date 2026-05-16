import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerCloudTools } from '../tools/cloud.js';

describe('cloud tools', () => {
  let configDir: string;
  let client: Client;

  async function connectCloudTools(options: { cwd?: string } = {}) {
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerCloudTools(server, {
      cloudBaseUrl: 'https://cloud.test',
      cwd: options.cwd ?? '/repo/project',
    });

    client = new Client({ name: 'test-client', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);
  }

  async function writeConfig(filename: string, value: unknown) {
    await writeFile(path.join(configDir, filename), JSON.stringify(value), 'utf8');
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    configDir = await mkdtemp(path.join(tmpdir(), 'relaycast-cloud-tools-'));
    vi.stubEnv('AGENT_RELAY_CONFIG_DIR', configDir);
    await connectCloudTools();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await client?.close();
    await rm(configDir, { recursive: true, force: true });
  });

  it('returns NEEDS_CLOUD_LOGIN when cloud.json is missing', async () => {
    const result = await client.callTool({
      name: 'cloud.agent.spawn',
      arguments: { cli: 'claude', prompt: 'do work' },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: 'NEEDS_CLOUD_LOGIN',
      remediation: 'agent-relay cloud login',
    });
  });

  it('returns NEEDS_CLI_CONNECTION before making a Cloud request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await writeConfig('cloud.json', {
      cloudToken: 'cloud_tok',
      workspaces: [{ id: 'ws_1', name: 'Workspace' }],
    });
    await writeConfig('connections.json', { connections: {} });

    const result = await client.callTool({
      name: 'cloud.agent.spawn',
      arguments: { cli: 'codex', prompt: 'do work' },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: 'NEEDS_CLI_CONNECTION',
      remediation: 'agent-relay connect codex',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires workspace_id when multiple Cloud workspaces are linked', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await writeConfig('cloud.json', {
      cloudToken: 'cloud_tok',
      workspaces: [{ id: 'ws_1' }, { id: 'ws_2' }],
    });
    await writeConfig('connections.json', { connections: { claude: { command: 'claude' } } });

    const result = await client.callTool({
      name: 'cloud.agent.spawn',
      arguments: { cli: 'claude', prompt: 'do work' },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: 'WORKSPACE_REQUIRED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts spawn requests with snake_case input mapped to the Cloud route body', async () => {
    await writeConfig('cloud.json', {
      cloudToken: 'cloud_tok',
      userId: 'user_1',
      workspaces: [{ id: 'ws_1', name: 'Workspace' }],
    });
    await writeConfig('connections.json', { connections: { claude: { command: 'claude' } } });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { sandboxId: 'sb_1', status: 'starting' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await client.callTool({
      name: 'cloud.agent.spawn',
      arguments: {
        cli: 'claude',
        prompt: 'refactor auth',
        agent_name: 'alice',
        relaycast_channel: 'ch_demo',
        ttl_seconds: 3600,
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ sandboxId: 'sb_1', status: 'starting' });
    expect(fetchMock).toHaveBeenCalledWith('https://cloud.test/api/v1/agents/spawn', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer cloud_tok',
        'Content-Type': 'application/json',
      }),
    }));
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      workspaceId: 'ws_1',
      cli: 'claude',
      prompt: 'refactor auth',
      agentName: 'alice',
      relayfilePaths: ['/repo/project'],
      relaycastChannel: 'ch_demo',
      ttlSeconds: 3600,
    });
  });

  it('propagates structured Cloud remediation errors verbatim', async () => {
    await writeConfig('cloud.json', {
      cloudToken: 'cloud_tok',
      workspaces: [{ id: 'ws_1' }],
    });
    await writeConfig('connections.json', { connections: { claude: { command: 'claude' } } });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        ok: false,
        error: {
          code: 'NEEDS_RELAYFILE_SETUP',
          message: 'No Relayfile mount is configured for this path.',
          remediation: 'relayfile setup --local-dir <repo>',
        },
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await client.callTool({
      name: 'cloud.agent.spawn',
      arguments: { cli: 'claude', prompt: 'do work' },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      code: 'NEEDS_RELAYFILE_SETUP',
      message: 'No Relayfile mount is configured for this path.',
      remediation: 'relayfile setup --local-dir <repo>',
    });
  });
});
