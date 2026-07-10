import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  ExecOptions,
  ExecResult,
  LaunchOptions,
  RuntimeCapabilities,
  RuntimeHandle,
  WorkflowRuntime,
} from './types.js';

/**
 * "NO ISOLATION — do not run untrusted code"
 * "isolation: 'none' — SandboxedStepExecutor will NOT strip codex's internal sandbox gate"
 * "Intended for dev loop and CI tests only"
 */

export interface LocalRuntimeOptions {
  rootDir?: string;
  inheritEnv?: boolean;
  shell?: string;
}

interface LocalHandleState {
  handle: RuntimeHandle;
  homeDir: string;
  launchEnv: Record<string, string>;
}

export class LocalRuntime implements WorkflowRuntime {
  readonly id = 'local';

  /**
   * PTY support is intentionally disabled for v2. A later version can add
   * openPty via node-pty without changing the rest of the adapter contract.
   */
  readonly capabilities: RuntimeCapabilities = {
    pty: false,
    snapshots: false,
    isolation: 'none',
    persistentHandle: true,
    streamingLogs: true,
  };

  private readonly handles = new Map<string, LocalHandleState>();
  private readonly createdHomeDirs = new Set<string>();
  private readonly rootDir: string;
  private readonly inheritEnv: boolean;
  private readonly shell: string;

  constructor(options: LocalRuntimeOptions = {}) {
    if (process.platform === 'win32') {
      throw new Error('LocalRuntime is POSIX-only in v2 and does not support Windows');
    }

    this.rootDir = path.resolve(
      options.rootDir ?? path.join(os.tmpdir(), `agent-workforce-local-runtime-${randomUUID()}`),
    );
    // Default to false so host credentials and config paths do not leak into
    // the local step process and override sandbox-local HOME-based mounts.
    this.inheritEnv = options.inheritEnv ?? false;
    this.shell = options.shell ?? process.env.SHELL ?? '/bin/bash';
  }

  async launch(options: LaunchOptions = {}): Promise<RuntimeHandle> {
    await mkdir(this.rootDir, { recursive: true });

    const homeDir = path.join(this.rootDir, `local-${randomUUID()}`);
    await mkdir(homeDir, { recursive: true });

    const workdir = options.workdir ? this.resolveSandboxPath(homeDir, options.workdir) : undefined;
    if (workdir) {
      await mkdir(workdir, { recursive: true });
    }

    const handle: RuntimeHandle = {
      id: homeDir,
      homeDir,
      ...(workdir ? { workdir } : {}),
    };

    this.handles.set(handle.id, {
      handle,
      homeDir,
      launchEnv: { ...(options.env ?? {}) },
    });
    this.createdHomeDirs.add(path.resolve(homeDir));

    return handle;
  }

  async exec(handle: RuntimeHandle, command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const state = this.requireHandle(handle);
    const cwd = options.cwd
      ? this.resolveSandboxPath(state.homeDir, options.cwd)
      : (state.handle.workdir ?? state.homeDir);
    const env = this.buildExecEnv(state, options.env ?? {});
    const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : undefined;

    return new Promise<ExecResult>((resolve, reject) => {
      const controller = new AbortController();
      let output = '';
      let settled = false;
      let timedOut = false;

      const child = spawn(command, {
        shell: this.shell,
        cwd,
        env,
        detached: true,
        signal: controller.signal,
      });

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        output += chunk;
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        output += chunk;
      });

      const timeoutHandle = timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
            this.killProcessGroup(child.pid);
          }, timeoutMs)
        : undefined;

      const finalize = (handler: () => void): void => {
        if (settled) {
          return;
        }

        settled = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        handler();
      };

      child.on('error', (error) => {
        if (timedOut && this.isAbortError(error)) {
          return;
        }

        finalize(() => reject(error));
      });

      child.on('close', (code) => {
        finalize(() => {
          if (timedOut && timeoutMs) {
            resolve({
              output: this.appendTimeoutNotice(output, timeoutMs),
              exitCode: 124,
            });
            return;
          }

          resolve({
            output,
            exitCode: code ?? 0,
          });
        });
      });
    });
  }

  async uploadFile(handle: RuntimeHandle, source: string | Buffer, destination: string): Promise<void> {
    const state = this.requireHandle(handle);
    const resolvedDestination = this.resolveSandboxPath(state.homeDir, destination);

    await mkdir(path.dirname(resolvedDestination), { recursive: true });
    if (typeof source === 'string') {
      await copyFile(source, resolvedDestination);
      return;
    }

    await writeFile(resolvedDestination, source);
  }

  async downloadFile(handle: RuntimeHandle, source: string, destination?: string): Promise<Buffer | void> {
    const state = this.requireHandle(handle);
    const resolvedSource = this.resolveSandboxPath(state.homeDir, source);
    const contents = await readFile(resolvedSource);

    if (!destination) {
      return contents;
    }

    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }

  async getHomeDir(handle: RuntimeHandle): Promise<string> {
    return this.requireHandle(handle).homeDir;
  }

  async destroy(handle: RuntimeHandle): Promise<void> {
    const state = this.handles.get(handle.id);
    if (!state) {
      return;
    }

    this.assertSafeToDestroy(state.homeDir);
    this.handles.delete(handle.id);
    this.createdHomeDirs.delete(path.resolve(state.homeDir));

    try {
      await rm(state.homeDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(
        `[LocalRuntime] Failed to remove sandbox home "${state.homeDir}":`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  private requireHandle(handle: RuntimeHandle): LocalHandleState {
    const state = this.handles.get(handle.id);
    if (!state) {
      throw new Error(`Runtime handle "${handle.id}" is no longer active`);
    }

    return state;
  }

  private buildExecEnv(
    state: LocalHandleState,
    execEnv: Record<string, string>,
  ): Record<string, string> {
    const baseline = this.inheritEnv ? this.buildInheritedEnv(state.homeDir) : this.buildMinimalEnv(state.homeDir);

    return {
      ...baseline,
      ...state.launchEnv,
      ...execEnv,
      HOME: state.homeDir,
      SHELL: this.shell,
    };
  }

  private buildInheritedEnv(homeDir: string): Record<string, string> {
    return {
      ...this.buildDefinedEnv(process.env),
      HOME: homeDir,
      SHELL: this.shell,
    };
  }

  private buildMinimalEnv(homeDir: string): Record<string, string> {
    return {
      HOME: homeDir,
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      SHELL: this.shell,
      ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
      ...(process.env.TERM ? { TERM: process.env.TERM } : {}),
      ...(process.env.USER ? { USER: process.env.USER } : {}),
    };
  }

  private buildDefinedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    return Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  }

  private resolveSandboxPath(homeDir: string, targetPath: string): string {
    if (path.isAbsolute(targetPath)) {
      const resolvedTarget = path.resolve(targetPath);
      if (this.isSubPath(homeDir, resolvedTarget)) {
        return resolvedTarget;
      }
    }

    const relativePath = path.isAbsolute(targetPath)
      ? path.relative(path.parse(targetPath).root, targetPath)
      : targetPath;
    const resolved = path.resolve(homeDir, relativePath);

    if (!this.isSubPath(homeDir, resolved)) {
      throw new Error(`Path escapes LocalRuntime sandbox: ${targetPath}`);
    }

    return resolved;
  }

  private assertSafeToDestroy(homeDir: string): void {
    const resolvedHome = path.resolve(homeDir);
    if (resolvedHome === path.resolve(os.homedir())) {
      throw new Error(`Refusing to destroy LocalRuntime homeDir "${homeDir}" because it matches os.homedir()`);
    }

    if (!this.isSubPath(this.rootDir, resolvedHome)) {
      throw new Error(
        `Refusing to destroy LocalRuntime homeDir "${homeDir}" because it is outside rootDir "${this.rootDir}"`,
      );
    }

    if (!this.createdHomeDirs.has(resolvedHome)) {
      throw new Error(`Refusing to destroy LocalRuntime homeDir "${homeDir}" because it was not created by this runtime`);
    }
  }

  private isSubPath(parentDir: string, targetPath: string): boolean {
    const relative = path.relative(path.resolve(parentDir), path.resolve(targetPath));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }

  private killProcessGroup(pid?: number): void {
    if (!pid) {
      return;
    }

    try {
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      if (!this.isMissingProcessError(error)) {
        console.warn(
          `[LocalRuntime] Failed to kill process group ${pid}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  private appendTimeoutNotice(output: string, timeoutMs: number): string {
    return `${output}\n[timeout after ${timeoutMs}ms]`;
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
  }

  private isMissingProcessError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH';
  }
}
