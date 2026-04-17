import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRelayMcpServer } from '@relaycast/mcp';
import { listCliTools, runCli } from '../index.js';

describe('relaycast', () => {
  it('exposes the same command names as the MCP tool list', async () => {
    const mcpServer = createRelayMcpServer({});
    const client = new Client({ name: 'cli-parity-test', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      mcpServer.connect(serverTransport),
    ]);

    try {
      const [cliTools, mcpTools] = await Promise.all([
        listCliTools(),
        client.listTools(),
      ]);

      expect(cliTools.map((tool) => tool.name).sort()).toEqual(
        mcpTools.tools.map((tool) => tool.name).sort(),
      );
    } finally {
      await Promise.allSettled([
        client.close(),
        mcpServer.close(),
      ]);
    }
  });

  it('prints MCP tools from the tools command', async () => {
    let stdout = '';
    let stderr = '';

    const exitCode = await runCli(['tools'], {
      stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
      stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      env: {},
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('workspace.create');
    expect(stdout).toContain('message.post');
    expect(stdout).toContain('integration.command.invoke');
  });

  it('calls an MCP tool by command name', async () => {
    let stdout = '';
    let stderr = '';

    const exitCode = await runCli(['workspace.set_key', '--api-key', 'rk_live_test'], {
      stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
      stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      env: {},
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({
      message: 'Workspace key set. Call "agent.register" to join this workspace.',
    });
  });
});
