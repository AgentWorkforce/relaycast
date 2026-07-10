import { Buffer } from 'node:buffer';
import type {
  ExecOptions,
  ExecResult,
  LaunchOptions,
  RuntimeCapabilities,
  RuntimeHandle,
  WorkflowRuntime,
} from './types.js';

export interface LocalHttpRuntimeOptions {
  baseUrl: string;
}

type LocalSandboxRecord = {
  id?: string;
  sandboxId?: string;
  state?: string;
  status?: string;
  homeDir?: string;
  workdir?: string;
};

export class LocalHttpRuntime implements WorkflowRuntime {
  readonly id = 'local-http';

  readonly capabilities: RuntimeCapabilities = {
    pty: false,
    snapshots: false,
    isolation: 'strong',
    persistentHandle: true,
    streamingLogs: true,
  };

  private readonly baseUrl: string;

  constructor(options: LocalHttpRuntimeOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    if (!this.baseUrl) {
      throw new Error('LocalHttpRuntime baseUrl is required');
    }
  }

  async launch(options: LaunchOptions = {}): Promise<RuntimeHandle> {
    const labels = {
      ...(options.labels ?? {}),
      ...(options.label ? { step: options.label } : {}),
    };
    const response = await fetch(`${this.baseUrl}/sandboxes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: options.name ?? options.label,
        labels,
        env: options.env ?? {},
        envVars: options.env ?? {},
        workdir: options.workdir,
        timeoutSeconds: options.createTimeoutSeconds,
      }),
    });
    await assertOk(response, 'create local sandbox');
    return handleFromLocalRecord(await response.json() as LocalSandboxRecord);
  }

  attachSandbox(record: LocalSandboxRecord, options: { homeDir?: string; workdir?: string } = {}): RuntimeHandle {
    return handleFromLocalRecord({
      ...record,
      ...(options.homeDir ? { homeDir: options.homeDir } : {}),
      ...(options.workdir ? { workdir: options.workdir } : {}),
    });
  }

  async exec(handle: RuntimeHandle, command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const response = await fetch(`${this.baseUrl}/sandboxes/${encodeURIComponent(handle.id)}/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        command,
        cwd: options.cwd,
        env: options.env,
        timeoutSeconds: options.timeoutMs ? Math.ceil(options.timeoutMs / 1000) : undefined,
      }),
    });
    await assertOk(response, 'execute local sandbox command');
    const body = await response.json() as {
      output?: string;
      stdout?: string;
      stderr?: string;
      result?: string;
      exitCode?: number;
    };
    return {
      output: body.output ?? body.result ?? [body.stdout, body.stderr].filter(Boolean).join('') ?? '',
      exitCode: typeof body.exitCode === 'number' ? body.exitCode : 0,
    };
  }

  async uploadFile(handle: RuntimeHandle, source: string | Buffer, destination: string): Promise<void> {
    const content = Buffer.isBuffer(source)
      ? source
      : Buffer.from(source, 'utf8');
    const response = await fetch(`${this.baseUrl}/sandboxes/${encodeURIComponent(handle.id)}/files`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entries: [{
          destination,
          source: content.toString('base64'),
        }],
      }),
    });
    await assertOk(response, 'upload local sandbox file');
  }

  async downloadFile(handle: RuntimeHandle, source: string, destination?: string): Promise<Buffer | void> {
    const url = new URL(`${this.baseUrl}/sandboxes/${encodeURIComponent(handle.id)}/files`);
    url.searchParams.set('path', source);
    const response = await fetch(url);
    await assertOk(response, 'download local sandbox file');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (destination) {
      const { writeFile, mkdir } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, buffer);
      return;
    }
    return buffer;
  }

  async getHomeDir(handle: RuntimeHandle): Promise<string> {
    return handle.homeDir ?? '/home/daytona';
  }

  async destroy(handle: RuntimeHandle): Promise<void> {
    const response = await fetch(`${this.baseUrl}/sandboxes/${encodeURIComponent(handle.id)}`, {
      method: 'DELETE',
    });
    if (response.status === 404) return;
    await assertOk(response, 'delete local sandbox');
  }
}

function handleFromLocalRecord(record: LocalSandboxRecord): RuntimeHandle {
  const id = record.sandboxId ?? record.id;
  if (!id) {
    throw new Error('Local sandbox response is missing sandboxId');
  }
  return {
    id,
    homeDir: record.homeDir ?? '/home/daytona',
    workdir: record.workdir ?? '/project',
  };
}

async function assertOk(response: Response, action: string): Promise<void> {
  if (response.ok) return;
  const body = await response.text().catch(() => '');
  throw new Error(`Failed to ${action}: HTTP ${response.status}${body ? `: ${body.slice(0, 500)}` : ''}`);
}
