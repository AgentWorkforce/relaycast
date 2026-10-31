import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerCloudTools } from '../tools/cloud.js';

describe('cloud local mount tools', () => {
  let tempRoot: string;
  let mcpServer: McpServer;
  let client: Client;
  let runCommand: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'relaycast-cloud-tools-'));
    runCommand = vi.fn();
    mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerCloudTools(mcpServer, {
      relayfileBin: 'relayfile-test',
      runCommand,
    });

    client = new Client({ name: 'test-client', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), mcpServer.connect(st)]);
  });

  afterEach(async () => {
    await client.close();
    await mcpServer.close();
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('cloud.local-mount.ensure returns running without starting an existing mount', async () => {
    runCommand.mockResolvedValueOnce({
      stdout: JSON.stringify({
        localDir: tempRoot,
        workspaceId: 'ws_existing',
        running: true,
        conflictCount: 0,
        pid: 123,
      }),
      stderr: '',
    });

    const result = await client.callTool({
      name: 'cloud.local-mount.ensure',
      arguments: { localDir: tempRoot },
    });

    expect(result.structuredContent).toEqual({
      mountPath: tempRoot,
      workspaceId: 'ws_existing',
      status: 'running',
    });
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith(
      'relayfile-test',
      ['status', '--local-dir', tempRoot, '--json'],
      { cwd: tempRoot },
    );
  });

  it('cloud.local-mount.ensure starts relayfile setup when the mount is stopped', async () => {
    runCommand
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          localDir: tempRoot,
          workspaceId: 'ws_existing',
          running: false,
          conflictCount: 0,
        }),
        stderr: '',
      })
      .mockResolvedValueOnce({ stdout: 'started\n', stderr: '' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          localDir: tempRoot,
          workspaceId: 'ws_existing',
          running: true,
          conflictCount: 0,
          pid: 456,
        }),
        stderr: '',
      });

    const result = await client.callTool({
      name: 'cloud.local-mount.ensure',
      arguments: { localDir: tempRoot },
    });

    expect(result.structuredContent).toEqual({
      mountPath: tempRoot,
      workspaceId: 'ws_existing',
      status: 'started',
    });
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      'relayfile-test',
      [
        'setup',
        '--local-dir',
        tempRoot,
        '--workspace',
        `cloud-${path.basename(tempRoot)}`,
        '--provider',
        'none',
        '--background',
        '--no-open',
      ],
      { cwd: tempRoot },
    );
  });

  it('cloud.local-mount.status reports synthesized conflict count from disk', async () => {
    const relayDir = path.join(tempRoot, '.relay');
    await mkdir(path.join(relayDir, 'conflicts', 'nested'), { recursive: true });
    await writeFile(path.join(relayDir, 'state.json'), JSON.stringify({
      workspaceId: 'ws_disk',
      lastReconcileAt: '2026-05-21T12:00:00.000Z',
      pendingConflicts: 1,
    }));
    await writeFile(path.join(relayDir, 'conflicts', 'file.local'), 'local edit');
    await writeFile(path.join(relayDir, 'conflicts', 'nested', 'other.local'), 'other edit');
    runCommand.mockRejectedValue(new Error('relayfile unavailable'));

    const result = await client.callTool({
      name: 'cloud.local-mount.status',
      arguments: { localDir: tempRoot },
    });

    expect(result.structuredContent).toEqual({
      running: false,
      lastSync: '2026-05-21T12:00:00.000Z',
      conflictCount: 2,
    });
  });

  it('cloud.local-mount.stop is idempotent when no mount is running', async () => {
    runCommand.mockResolvedValueOnce({
      stdout: JSON.stringify({
        localDir: tempRoot,
        workspaceId: 'ws_existing',
        running: false,
        conflictCount: 0,
      }),
      stderr: '',
    });

    const result = await client.callTool({
      name: 'cloud.local-mount.stop',
      arguments: { localDir: tempRoot },
    });

    expect(result.structuredContent).toEqual({ stopped: true });
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it('cloud.local-mount.stop stops the workspace when status has a workspace id', async () => {
    runCommand
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          localDir: tempRoot,
          workspaceId: 'ws_existing',
          running: true,
          conflictCount: 0,
          pid: 789,
        }),
        stderr: '',
      })
      .mockResolvedValueOnce({ stdout: 'stopped\n', stderr: '' });

    const result = await client.callTool({
      name: 'cloud.local-mount.stop',
      arguments: { localDir: tempRoot },
    });

    expect(result.structuredContent).toEqual({ stopped: true });
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      'relayfile-test',
      ['stop', 'ws_existing'],
    );
  });
});
