import { uploadCode } from "@cloud/core/storage/code-transfer.js";
import type { ScopedS3Client } from "@cloud/core/storage/client.js";

export type WorkflowRunResponse = {
  runId: string;
  sandboxId?: string | null;
  dispatchType?: string;
  dispatchedTo?: string;
  assignmentId?: string;
  status: string;
};

export type WorkflowFileType = "yaml" | "ts" | "py";

export interface PostWorkflowOptions {
  apiUrl: string;
  workflow: string;
  fileType: WorkflowFileType;
}

export interface UploadCodeAndRunOptions {
  apiUrl: string;
  localDir: string;
  fileType: WorkflowFileType;
  s3Client: ScopedS3Client;
}

export class WorkflowClientError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "WorkflowClientError";
    this.statusCode = statusCode;
  }
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

const parseErrorBody = async (response: Response): Promise<string> => {
  const body = await response.text();
  if (!body) return response.statusText || "Request failed";
  try {
    const payload = JSON.parse(body) as Record<string, unknown>;
    if (typeof payload.error === "string") return payload.error;
    if (typeof payload.message === "string") return payload.message;
  } catch {
    // ignore JSON parse errors and fall back to raw body
  }
  return body;
};

export async function postWorkflow(options: PostWorkflowOptions): Promise<WorkflowRunResponse> {
  const url = `${trimTrailingSlash(options.apiUrl)}/api/v1/workflows/run`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({
        workflow: options.workflow,
        fileType: options.fileType,
      }),
    });
  } catch (err) {
    throw new WorkflowClientError(
      `Network error connecting to ${url}: ${err instanceof Error ? err.message : String(err)}`,
      0
    );
  }

  if (response.status === 200) {
    const data = await response.json().catch(() => {
      throw new WorkflowClientError("Invalid JSON response from workflow API", 500);
    });

    if (
      typeof data !== "object" ||
      data === null ||
      typeof (data as { runId?: unknown }).runId !== "string" ||
      typeof (data as { status?: unknown }).status !== "string"
    ) {
      throw new WorkflowClientError("Invalid workflow run response payload", 500);
    }

    const sandboxId = (data as { sandboxId?: unknown }).sandboxId;
    if (sandboxId !== undefined && sandboxId !== null && typeof sandboxId !== "string") {
      throw new WorkflowClientError("Invalid workflow run response payload", 500);
    }

    return data as WorkflowRunResponse;
  }

  if (response.status === 401) {
    throw new WorkflowClientError(
      "Authentication failed. Sign in to the web app and try again.",
      401
    );
  }

  if (response.status === 400) {
    const message = await parseErrorBody(response);
    throw new WorkflowClientError(`Bad request: ${message}`, 400);
  }

  if (response.status === 500) {
    const message = await parseErrorBody(response);
    throw new WorkflowClientError(`Server error: ${message}`, 500);
  }

  const message = await parseErrorBody(response);
  throw new WorkflowClientError(`Request failed (${response.status}): ${message}`, response.status);
}

export async function uploadCodeAndRun(
  options: UploadCodeAndRunOptions
): Promise<WorkflowRunResponse> {
  const s3CodeKey = await uploadCode(options.s3Client, options.localDir);
  return postWorkflow({
    apiUrl: options.apiUrl,
    workflow: s3CodeKey,
    fileType: options.fileType,
  });
}
