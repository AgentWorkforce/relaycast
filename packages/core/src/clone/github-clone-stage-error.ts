export type GithubCloneFailureStage =
  | "github_tarball_fetch_failed"
  | "relayfile_tar_import_fetch_failed"
  | "relayfile_tar_import_failed";

export class GithubCloneStageError extends Error {
  readonly stage: GithubCloneFailureStage;
  readonly status?: number;
  override readonly cause?: unknown;

  constructor(
    stage: GithubCloneFailureStage,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(`${stage}: ${message}`);
    this.name = "GithubCloneStageError";
    this.stage = stage;
    this.status = options.status;
    this.cause = options.cause;
  }
}

export function toGithubCloneStageError(
  stage: GithubCloneFailureStage,
  error: unknown,
): GithubCloneStageError {
  if (error instanceof GithubCloneStageError) {
    return error;
  }

  const status = getErrorStatus(error);
  const message =
    error instanceof Error && error.message ? error.message : String(error);
  return new GithubCloneStageError(stage, message || "unknown error", {
    status,
    cause: error,
  });
}

export function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const withStatus = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };

  if (typeof withStatus.status === "number") {
    return withStatus.status;
  }

  if (typeof withStatus.statusCode === "number") {
    return withStatus.statusCode;
  }

  if (typeof withStatus.response?.status === "number") {
    return withStatus.response.status;
  }

  return undefined;
}
