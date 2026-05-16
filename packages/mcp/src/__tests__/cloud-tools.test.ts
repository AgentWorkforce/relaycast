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

  it('rejects mixed-case fallback fields in cloud.json (no cloud_token / workspace_id / user_id)', async () => {
    // Schema accepts only the canonical camelCase shape. AGENTS.md prohibits
    // mixed-case fallbacks, so a config that only carries `cloud_token` or
    // `workspace_id` must fail closed as NEEDS_CLOUD_LOGIN rather than silently
    // bridging the legacy field names.
    await writeConfig('cloud.json', {
      cloud_token: 'legacy_tok',
      user_id: 'user_legacy',
      workspaces: [{ workspace_id: 'ws_legacy' }],
    });
    await writeConfig('connections.json', { connections: { claude: { command: 'claude' } } });

    const result = await client.callTool({
      name: 'cloud.agent.spawn',
      arguments: { cli: 'claude', prompt: 'do work' },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: 'NEEDS_CLOUD_LOGIN',
    });
  });

  it('returns CLOUD_REQUEST_FAILED when cloud.json contains malformed JSON', async () => {
    // Spy on fetch first so we can prove the failure surfaced in config
    // parsing preflight, not via a downstream network-error path that would
    // also map to CLOUD_REQUEST_FAILED. Without this guard the assertion
    // would still pass even if a regression made the tool issue a network
    // request with a corrupt token, which is what we want to prevent.
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await writeFile(path.join(configDir, 'cloud.json'), '{ this is not json', 'utf8');

    const result = await client.callTool({
      name: 'cloud.agent.spawn',
      arguments: { cli: 'claude', prompt: 'do work' },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: 'CLOUD_REQUEST_FAILED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns CLOUD_REQUEST_FAILED when fetch throws (network failure)', async () => {
    await writeConfig('cloud.json', {
      cloudToken: 'cloud_tok',
      workspaces: [{ id: 'ws_1' }],
    });
    await writeConfig('connections.json', { connections: { claude: { command: 'claude' } } });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await client.callTool({
      name: 'cloud.agent.spawn',
      arguments: { cli: 'claude', prompt: 'do work' },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: 'CLOUD_REQUEST_FAILED',
      message: 'ECONNREFUSED',
    });
  });

  it('cloud.agent.list works for multi-workspace logins when workspace_id is omitted', async () => {
    // Previously this returned WORKSPACE_REQUIRED, contradicting the tool's
    // own description ("optionally scoped to a workspace"). The list tool now
    // opts out of workspace gating when no workspace_id is supplied so
    // account-wide listing works.
    await writeConfig('cloud.json', {
      cloudToken: 'cloud_tok',
      workspaces: [{ id: 'ws_1' }, { id: 'ws_2' }],
    });
    await writeConfig('connections.json', { connections: {} });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { agents: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await client.callTool({
      name: 'cloud.agent.list',
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cloud.test/api/v1/agents',
      expect.any(Object),
    );
  });

  it('cloud.agent.list still scopes by workspace when one is supplied', async () => {
    await writeConfig('cloud.json', {
      cloudToken: 'cloud_tok',
      workspaces: [{ id: 'ws_1' }, { id: 'ws_2' }],
    });
    await writeConfig('connections.json', { connections: {} });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { agents: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await client.callTool({
      name: 'cloud.agent.list',
      arguments: { workspace_id: 'ws_2' },
    });

    // Assert success in addition to the URL shape so a regression in
    // response parsing (or any path that errors after fetch is constructed
    // correctly) is caught by this test, not silently passed.
    expect(result.isError).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cloud.test/api/v1/agents?workspaceId=ws_2',
      expect.any(Object),
    );
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
