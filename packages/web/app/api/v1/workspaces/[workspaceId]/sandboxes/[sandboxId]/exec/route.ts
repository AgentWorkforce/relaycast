import { NextRequest, NextResponse } from "next/server";
import {
  MAX_COMMAND_TIMEOUT_SECONDS,
  createDaytonaClient,
  isRecord,
  isStringRecord,
  jsonError,
  normalizeOptionalString,
  normalizeTimeoutSeconds,
  readJsonBody,
  requireSandboxRecord,
  requireWorkspaceSandboxAuth,
  type ErrorResponse,
  type WorkspaceSandboxRouteContext,
} from "../../sandbox-utils";
import { daytonaCommandOutput } from "@/lib/daytona-command-output";

type ExecBody = {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutSeconds: number;
};

type ExecResponse = {
  sandboxId: string;
  exitCode: number;
  output: string;
};

function parseExecBody(value: unknown): ExecBody | null {
  if (!isRecord(value)) {
    return null;
  }

  const command = normalizeOptionalString(value.command);
  if (!command) {
    return null;
  }

  if (value.env !== undefined && !isStringRecord(value.env)) {
    return null;
  }

  const timeoutSeconds = normalizeTimeoutSeconds(value.timeoutSeconds, {
    defaultSeconds: 60,
    maxSeconds: MAX_COMMAND_TIMEOUT_SECONDS,
  });
  if (timeoutSeconds === null) {
    return null;
  }

  return {
    command,
    cwd: normalizeOptionalString(value.cwd),
    env: value.env,
    timeoutSeconds,
  };
}

export async function POST(
  request: NextRequest,
  context: WorkspaceSandboxRouteContext,
) {
  const access = await requireWorkspaceSandboxAuth(request, context);
  if (!access.ok) {
    return access.response;
  }

  const sandboxRecord = await requireSandboxRecord(
    access.workspaceId,
    access.sandboxId,
  );
  if (!sandboxRecord.ok) {
    return sandboxRecord.response;
  }

  const body = parseExecBody(await readJsonBody(request));
  if (!body) {
    return jsonError("Invalid request body", "invalid_request", 400);
  }

  try {
    const sandbox = await createDaytonaClient().get(access.sandboxId!);
    const result = await sandbox.process.executeCommand(
      body.command,
      body.cwd,
      body.env,
      body.timeoutSeconds,
    );

    return NextResponse.json<ExecResponse>({
      sandboxId: access.sandboxId!,
      exitCode: result.exitCode,
      output: daytonaCommandOutput(result),
    });
  } catch (error) {
    console.error(
      "[workforce-sandbox] exec failed:",
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json<ErrorResponse>(
      { error: "Failed to execute command", code: "sandbox_exec_failed" },
      { status: 502 },
    );
  }
}
