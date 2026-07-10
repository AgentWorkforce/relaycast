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
  state?: string;
  createdAt?: string;
  updatedAt?: string;
  lastActivityAt?: string;
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

export interface AsyncExecStartResult {
  sessionId: string;
  commandId: string;
}

export interface AsyncExecStatus {
  exitCode: number | null;
}

export interface WorkflowRuntime {
  readonly id: string;
  readonly capabilities: RuntimeCapabilities;

  launch(options?: LaunchOptions): Promise<RuntimeHandle>;
  launchDetached?(options?: LaunchOptions): Promise<RuntimeHandle>;
  getById?(
    id: string,
    options?: { owned?: boolean; homeDir?: string; workdir?: string; states?: readonly string[] | null },
  ): Promise<RuntimeHandle | null>;
  findAllByLabels?(
    labels: Record<string, string>,
    options?: { states?: readonly string[] | null; limit?: number; pageSize?: number },
  ): Promise<RuntimeHandle[]>;
  exec(handle: RuntimeHandle, command: string, options?: ExecOptions): Promise<ExecResult>;
  startExec?(handle: RuntimeHandle, command: string, options?: ExecOptions & { sessionId?: string }): Promise<AsyncExecStartResult>;
  getExecStatus?(handle: RuntimeHandle, sessionId: string, commandId: string): Promise<AsyncExecStatus>;
  getExecLogs?(handle: RuntimeHandle, sessionId: string, commandId: string): Promise<ExecResult>;
  uploadFile(handle: RuntimeHandle, source: string | Buffer, destination: string): Promise<void>;
  downloadFile(handle: RuntimeHandle, source: string, destination?: string): Promise<Buffer | void>;
  getHomeDir(handle: RuntimeHandle): Promise<string>;
  start?(handle: RuntimeHandle): Promise<RuntimeHandle>;
  stop?(handle: RuntimeHandle): Promise<void>;
  destroy(handle: RuntimeHandle): Promise<void>;
}
