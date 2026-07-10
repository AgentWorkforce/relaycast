import { NextRequest, NextResponse } from "next/server";
import {
  decodeBase64,
  createDaytonaClient,
  isRecord,
  jsonError,
  normalizeOptionalString,
  readJsonBody,
  requireSandboxRecord,
  requireWorkspaceSandboxAuth,
  type ErrorResponse,
  type WorkspaceSandboxRouteContext,
} from "../../sandbox-utils";

type FileEntry = {
  source: Buffer;
  destination: string;
};

function parseFileEntries(value: unknown): FileEntry[] | null {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    return null;
  }

  const entries: FileEntry[] = [];
  for (const entry of value.entries) {
    if (!isRecord(entry)) {
      return null;
    }

    const source = typeof entry.source === "string"
      ? decodeBase64(entry.source)
      : null;
    const destination = normalizeOptionalString(entry.destination);
    if (!source || !destination) {
      return null;
    }

    entries.push({ source, destination });
  }

  return entries.length > 0 ? entries : null;
}

export async function PUT(
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

  const entries = parseFileEntries(await readJsonBody(request));
  if (!entries) {
    return jsonError("Invalid request body", "invalid_request", 400);
  }

  try {
    const sandbox = await createDaytonaClient().get(access.sandboxId!);
    for (const entry of entries) {
      await sandbox.fs.uploadFile(entry.source, entry.destination);
    }

    return NextResponse.json({
      sandboxId: access.sandboxId,
      uploaded: entries.length,
    });
  } catch (error) {
    console.error(
      "[workforce-sandbox] file upload failed:",
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json<ErrorResponse>(
      { error: "Failed to upload files", code: "sandbox_file_upload_failed" },
      { status: 502 },
    );
  }
}
