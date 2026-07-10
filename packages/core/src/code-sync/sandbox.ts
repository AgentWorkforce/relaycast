/**
 * Sandbox execution helpers — wraps command execution with error handling
 * and provides an adapter for Daytona sandbox objects.
 */

import type { SandboxLike } from "./types.js";
import { SandboxCommandError } from "./errors.js";

/**
 * Execute a command on a sandbox, throwing SandboxCommandError on non-zero exit.
 */
export async function exec(
  sandbox: SandboxLike,
  command: string,
  cwd?: string
): Promise<{ exitCode: number; result: string }> {
  const response = await sandbox.process.executeCommand(command, cwd);
  if (response.exitCode !== 0) {
    throw new SandboxCommandError(command, response.exitCode, response.result);
  }
  return response;
}

/**
 * Adapt a Daytona sandbox (which has extra params on executeCommand)
 * to the minimal SandboxLike interface, eliminating unsafe casts.
 */
export function asSandboxLike(obj: {
  fs: {
    uploadFile(source: string | Buffer, remotePath: string): Promise<void>;
    downloadFile(remotePath: string): Promise<Buffer>;
  };
  process: {
    executeCommand(command: string, cwd?: string, ...extra: unknown[]): Promise<{ exitCode: number; result: string }>;
  };
}): SandboxLike {
  return {
    fs: obj.fs,
    process: {
      executeCommand: (command: string, cwd?: string) =>
        obj.process.executeCommand(command, cwd),
    },
  };
}
