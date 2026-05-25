import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const DEFAULT_RELAYFILE_BIN = 'relayfile';

type CommandRunner = (
  file: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

export interface CloudToolsOptions {
  relayfileBin?: string;
  runCommand?: CommandRunner;
}

interface LocalMountStatus {
  localDir: string;
  workspaceId: string;
  running: boolean;
  lastSync?: string;
  conflictCount: number;
  pid?: number;
}

const localDirInputSchema = {
  localDir: z.string().min(1).describe('Local project directory to expose through the relayfile mount'),
};

const ensureOutputSchema = {
  mountPath: z.string().describe('Absolute local path of the relayfile mount'),
  workspaceId: z.string().describe('Relayfile workspace ID associated with this mount, when known'),
  status: z.enum(['running', 'started']).describe('running when the daemon already existed, started when this call launched it'),
};

const statusOutputSchema = {
  running: z.boolean().describe('True when a relayfile background daemon is recorded for this local directory'),
  lastSync: z.string().nullable().describe('Last successful local reconcile timestamp, or null if none is recorded'),
  conflictCount: z.number().int().nonnegative().describe('Number of conflict artifacts under .relay/conflicts'),
};

const stopOutputSchema = {
  stopped: z.boolean().describe('Always true once no running mount remains or a stop signal was sent'),
};

export function registerCloudTools(
  server: McpServer,
  options: CloudToolsOptions = {},
): void {
  const relayfileBin = options.relayfileBin ?? DEFAULT_RELAYFILE_BIN;
  const runCommand = options.runCommand ?? defaultRunCommand;

  server.registerTool('cloud.local-mount.ensure', {
    title: 'Ensure Cloud Local Mount',
    description: 'Ensure a relayfile-backed local mount is running for a project directory. If the mount is already running, this is a no-op. Otherwise it starts relayfile setup in background mode and returns the mount path and workspace ID when available.',
    inputSchema: localDirInputSchema,
    outputSchema: ensureOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ localDir }) => {
    const mountPath = path.resolve(localDir);
    const before = await readMountStatus(mountPath, relayfileBin, runCommand);
    if (before.running) {
      return jsonToolResult({
        mountPath,
        workspaceId: before.workspaceId,
        status: 'running' as const,
      });
    }

    await runCommand(relayfileBin, [
      'setup',
      '--local-dir',
      mountPath,
      '--workspace',
      defaultWorkspaceName(mountPath),
      '--provider',
      'none',
      '--background',
      '--no-open',
    ], { cwd: mountPath });

    const after = await readMountStatus(mountPath, relayfileBin, runCommand);
    return jsonToolResult({
      mountPath,
      workspaceId: after.workspaceId,
      status: 'started' as const,
    });
  });

  server.registerTool('cloud.local-mount.status', {
    title: 'Get Cloud Local Mount Status',
    description: 'Report local relayfile mount liveness, last sync timestamp, and conflict artifact count for a project directory.',
    inputSchema: localDirInputSchema,
    outputSchema: statusOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ localDir }) => {
    const status = await readMountStatus(path.resolve(localDir), relayfileBin, runCommand);
    return jsonToolResult({
      running: status.running,
      lastSync: status.lastSync ?? null,
      conflictCount: status.conflictCount,
    });
  });

  server.registerTool('cloud.local-mount.stop', {
    title: 'Stop Cloud Local Mount',
    description: 'Stop the relayfile background mount for a project directory. The operation is idempotent and keeps the local mirror on disk.',
    inputSchema: localDirInputSchema,
    outputSchema: stopOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ localDir }) => {
    const mountPath = path.resolve(localDir);
    const status = await readMountStatus(mountPath, relayfileBin, runCommand);
    if (status.running) {
      if (status.workspaceId) {
        await stopWorkspace(relayfileBin, status.workspaceId, runCommand);
      } else if (status.pid) {
        stopProcess(status.pid);
      }
    }
    return jsonToolResult({ stopped: true });
  });
}

async function defaultRunCommand(
  file: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(file, args, {
    cwd: options.cwd,
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function readMountStatus(
  localDir: string,
  relayfileBin: string,
  runCommand: CommandRunner,
): Promise<LocalMountStatus> {
  const fallback = await readMountStatusFromDisk(localDir);
  try {
    const { stdout } = await runCommand(relayfileBin, [
      'status',
      '--local-dir',
      localDir,
      '--json',
    ], { cwd: localDir });
    const parsed = JSON.parse(stdout) as Partial<LocalMountStatus>;
    return {
      localDir,
      workspaceId: stringValue(parsed.workspaceId) ?? fallback.workspaceId,
      running: booleanValue(parsed.running) ?? fallback.running,
      lastSync: stringValue(parsed.lastSync) ?? fallback.lastSync,
      conflictCount: Math.max(numberValue(parsed.conflictCount) ?? 0, fallback.conflictCount),
      pid: numberValue(parsed.pid) ?? fallback.pid,
    };
  } catch {
    return fallback;
  }
}

async function readMountStatusFromDisk(localDir: string): Promise<LocalMountStatus> {
  const state = await readRelayState(localDir);
  const pid = await readMountPid(localDir, nestedPidValue(state, 'daemon'));
  return {
    localDir,
    workspaceId: stringValue(state?.workspaceId) ?? '',
    running: pid !== undefined,
    lastSync: stringValue(state?.lastReconcileAt),
    conflictCount: Math.max(
      await countFiles(path.join(localDir, '.relay', 'conflicts')),
      numberValue(state?.pendingConflicts) ?? 0,
    ),
    pid,
  };
}

async function readRelayState(localDir: string): Promise<Record<string, unknown> | undefined> {
  try {
    const payload = await readFile(path.join(localDir, '.relay', 'state.json'), 'utf8');
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

async function readMountPid(localDir: string, statePid?: unknown): Promise<number | undefined> {
  const pidFromState = numberValue(statePid);
  if (pidFromState && await isProcessRunning(pidFromState)) {
    return pidFromState;
  }

  try {
    const payload = await readFile(path.join(localDir, '.relay', 'mount.pid'), 'utf8');
    const parsed = JSON.parse(payload) as { pid?: unknown };
    const pid = numberValue(parsed.pid);
    if (pid && await isProcessRunning(pid)) {
      return pid;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function isProcessRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function countFiles(dir: string): Promise<number> {
  try {
    await access(dir, constants.R_OK);
  } catch {
    return 0;
  }

  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await countFiles(entryPath);
    } else if (entry.isFile()) {
      total += 1;
    }
  }
  return total;
}

async function stopWorkspace(
  relayfileBin: string,
  workspaceId: string,
  runCommand: CommandRunner,
): Promise<void> {
  try {
    await runCommand(relayfileBin, ['stop', workspaceId]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/no running mount/i.test(message)) {
      throw error;
    }
  }
}

function stopProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Stop is idempotent; a stale pid is already stopped from the tool's perspective.
  }
}

function jsonToolResult<T extends Record<string, unknown>>(payload: T) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function defaultWorkspaceName(localDir: string): string {
  const base = path.basename(localDir).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return base ? `cloud-${base}` : 'cloud-local-mount';
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nestedPidValue(source: Record<string, unknown> | undefined, key: string): unknown {
  const value = source?.[key];
  return value && typeof value === 'object' ? (value as Record<string, unknown>).pid : undefined;
}
