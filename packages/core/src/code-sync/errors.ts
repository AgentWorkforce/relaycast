/**
 * Custom error types for the code-sync module.
 */

export class SandboxCommandError extends Error {
  constructor(
    public readonly command: string,
    public readonly exitCode: number,
    public readonly output: string
  ) {
    super(`Command failed (exit ${exitCode}): ${command} — ${output}`);
    this.name = "SandboxCommandError";
  }
}

export class PatchApplyError extends Error {
  constructor(
    public readonly patchPath: string,
    message: string
  ) {
    super(message);
    this.name = "PatchApplyError";
  }
}
