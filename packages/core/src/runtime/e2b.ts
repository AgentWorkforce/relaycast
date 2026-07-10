import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CommandExitError, Sandbox } from 'e2b';
import type {
  ExecOptions,
  ExecResult,
  LaunchOptions,
  RuntimeCapabilities,
  RuntimeHandle,
  WorkflowRuntime,
} from './types.js';

export interface E2BRuntimeOptions {
  apiKey?: string;
  template?: string;
  defaultTimeoutMs?: number;
}

interface CommandErrorLike {
  exitCode?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  message?: unknown;
}

const DEFAULT_TEMPLATE = 'relay-orchestrator-e2b-v1';
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_HOME_DIR = '/home/user';

/**
 * E2B-backed WorkflowRuntime adapter for strongly isolated step execution.
 *
 * No interactive PTY support in v3 — use DaytonaRuntime for interactive Claude sessions.
 * Persistent handle optimization (reuse across steps) is a follow-up — SandboxedStepExecutor currently destroys after each step.
 */
export class E2BRuntime implements WorkflowRuntime {
  readonly id = 'e2b';
  readonly capabilities: RuntimeCapabilities = {
    pty: false,
    snapshots: true,
    isolation: 'strong',
    persistentHandle: true,
    streamingLogs: true,
  };

  private readonly sandboxes = new Map<string, Sandbox>();
  private readonly apiKey?: string;
  private readonly template: string;
  private readonly defaultTimeoutMs: number;

  constructor(options: E2BRuntimeOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.E2B_API_KEY;
    this.template = options.template ?? process.env.E2B_TEMPLATE ?? DEFAULT_TEMPLATE;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async launch(options: LaunchOptions = {}): Promise<RuntimeHandle> {
    const sandbox = await Sandbox.create(this.template, {
      ...(this.apiKey ? { apiKey: this.apiKey } : {}),
      ...(this.hasEntries(options.env) ? { envs: options.env } : {}),
      ...(options.label?.trim() ? { metadata: { label: options.label.trim() } } : {}),
      timeoutMs: this.defaultTimeoutMs,
    });

    try {
      const homeDir = await this.detectHomeDir(sandbox);
      const preflight = await this.runSandboxCommand(sandbox, 'command -v relayfile-mount', {
        timeoutMs: this.defaultTimeoutMs,
      });

      if (preflight.exitCode !== 0) {
        throw new Error(
          `E2B template "${this.template}" is missing relayfile-mount binary - rebuild per infra/e2b/README.md`,
        );
      }

      const handle: RuntimeHandle = {
        id: sandbox.sandboxId,
        homeDir,
        ...(options.workdir ? { workdir: options.workdir } : {}),
      };

      this.sandboxes.set(handle.id, sandbox);
      return handle;
    } catch (error) {
      await sandbox.kill().catch(() => {});
      throw error;
    }
  }

  async exec(handle: RuntimeHandle, command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const sandbox = this.requireSandbox(handle);
    const homeDir = await this.getHomeDir(handle);
    const cwd = this.resolveRemotePath(homeDir, options.cwd ?? handle.workdir ?? homeDir);
    const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : this.defaultTimeoutMs;

    return this.runSandboxCommand(sandbox, command, {
      cwd,
      env: this.hasEntries(options.env) ? options.env : undefined,
      timeoutMs,
    });
  }

  async uploadFile(handle: RuntimeHandle, source: string | Buffer, destination: string): Promise<void> {
    const sandbox = this.requireSandbox(handle);
    const homeDir = await this.getHomeDir(handle);
    const resolvedDestination = this.resolveRemotePath(homeDir, destination);
    const contents = typeof source === 'string' ? await readFile(source) : source;

    await sandbox.files.write(resolvedDestination, this.toArrayBuffer(contents));
  }

  async downloadFile(handle: RuntimeHandle, source: string, destination?: string): Promise<Buffer | void> {
    const sandbox = this.requireSandbox(handle);
    const homeDir = await this.getHomeDir(handle);
    const resolvedSource = this.resolveRemotePath(homeDir, source);
    const bytes = await sandbox.files.read(resolvedSource, { format: 'bytes' as const });
    const buffer = Buffer.from(bytes);

    if (!destination) {
      return buffer;
    }

    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, buffer);
  }

  async getHomeDir(handle: RuntimeHandle): Promise<string> {
    if (handle.homeDir) {
      return handle.homeDir;
    }

    const sandbox = this.requireSandbox(handle);
    const homeDir = await this.detectHomeDir(sandbox);
    handle.homeDir = homeDir;
    return homeDir;
  }

  async destroy(handle: RuntimeHandle): Promise<void> {
    const sandbox = this.sandboxes.get(handle.id);
    if (!sandbox) {
      return;
    }

    this.sandboxes.delete(handle.id);
    await sandbox.kill();
  }

  private requireSandbox(handle: RuntimeHandle): Sandbox {
    const sandbox = this.sandboxes.get(handle.id);
    if (!sandbox) {
      throw new Error(`Runtime handle "${handle.id}" is no longer active`);
    }

    return sandbox;
  }

  private async detectHomeDir(sandbox: Sandbox): Promise<string> {
    try {
      const result = await this.runSandboxCommand(sandbox, 'printf %s "$HOME"', {
        timeoutMs: this.defaultTimeoutMs,
      });
      const homeDir = result.output.trim();

      if (result.exitCode === 0 && homeDir) {
        return homeDir;
      }
    } catch {
      // Fall back to the standard E2B home if detection fails.
    }

    return DEFAULT_HOME_DIR;
  }

  private async runSandboxCommand(
    sandbox: Sandbox,
    command: string,
    options: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
    } = {},
  ): Promise<ExecResult> {
    try {
      const result = await sandbox.commands.run(command, {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(this.hasEntries(options.env) ? { envs: options.env } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      });

      return {
        output: this.combineOutput(result.stdout, result.stderr),
        exitCode: result.exitCode ?? 0,
      };
    } catch (error) {
      const normalized = this.normalizeCommandError(error);
      if (normalized) {
        return normalized;
      }

      throw error;
    }
  }

  private normalizeCommandError(error: unknown): ExecResult | null {
    if (!(error instanceof CommandExitError) && !this.hasExitCode(error)) {
      return null;
    }

    const candidate = error as CommandErrorLike;
    const stdout = typeof candidate.stdout === 'string' ? candidate.stdout : '';
    const stderr = typeof candidate.stderr === 'string' ? candidate.stderr : '';
    const output = this.combineOutput(stdout, stderr);

    return {
      output: output || (typeof candidate.message === 'string' ? candidate.message : ''),
      exitCode: typeof candidate.exitCode === 'number' ? candidate.exitCode : 1,
    };
  }

  private combineOutput(stdout: string, stderr: string): string {
    if (stdout && stderr) {
      return stdout.endsWith('\n') || stderr.startsWith('\n') ? `${stdout}${stderr}` : `${stdout}\n${stderr}`;
    }

    return stdout || stderr || '';
  }

  private resolveRemotePath(homeDir: string, targetPath: string): string {
    if (!targetPath) {
      return homeDir;
    }

    return path.posix.isAbsolute(targetPath) ? targetPath : path.posix.resolve(homeDir, targetPath);
  }

  private toArrayBuffer(buffer: Buffer): ArrayBuffer {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  }

  private hasEntries(record?: Record<string, string>): record is Record<string, string> {
    return !!record && Object.keys(record).length > 0;
  }

  private hasExitCode(error: unknown): error is { exitCode: number } {
    return typeof error === 'object' && error !== null && typeof (error as { exitCode?: unknown }).exitCode === 'number';
  }
}
