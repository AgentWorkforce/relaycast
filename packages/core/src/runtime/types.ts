export type IsolationLevel = 'none' | 'process' | 'strong';

export interface RuntimeCapabilities {
  pty: boolean;
  snapshots: boolean;
  isolation: IsolationLevel;
  persistentHandle: boolean;
  streamingLogs: boolean;
}

export interface LaunchOptions {
  env?: Record<string, string>;
  label?: string;
  name?: string;
  labels?: Record<string, string>;
  workdir?: string;
  createTimeoutSeconds?: number;
}

export interface RuntimeHandle {
  id: string;
  homeDir?: string;
  workdir?: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ExecResult {
  output: string;
  exitCode: number;
}

export interface WorkflowRuntime {
  readonly id: string;
  readonly capabilities: RuntimeCapabilities;

  launch(options?: LaunchOptions): Promise<RuntimeHandle>;
  exec(handle: RuntimeHandle, command: string, options?: ExecOptions): Promise<ExecResult>;
  uploadFile(handle: RuntimeHandle, source: string | Buffer, destination: string): Promise<void>;
  downloadFile(handle: RuntimeHandle, source: string, destination?: string): Promise<Buffer | void>;
  getHomeDir(handle: RuntimeHandle): Promise<string>;
  destroy(handle: RuntimeHandle): Promise<void>;
}

// ── ProcessBackend: runtime-only sandbox provisioning ─────────────────────────
// The broker builds the full command (CLI flags, MCP, auth env); the backend
// just provides an environment to run it in.

export interface ProcessBackend {
  createEnvironment(label: string): Promise<ProcessEnvironment>;
}

export interface ProcessEnvironment {
  id: string;
  homeDir: string;
  exec(command: string, opts?: { cwd?: string; env?: Record<string, string>; timeoutSeconds?: number }): Promise<{ output: string; exitCode: number }>;
  uploadFile(content: string | Buffer, remotePath: string): Promise<void>;
  destroy(): Promise<void>;
}
