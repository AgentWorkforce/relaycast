import type {
  GithubCloneCompletion,
  GithubCloneJobRequest,
} from "./github-clone-job.js";
import { runProductionGithubClone } from "./github-clone-production.js";

export interface GithubCloneExecutionResult extends GithubCloneCompletion {
  filesWritten?: number | null;
  headSha?: string | null;
  durationMs?: number | null;
  completedAt?: Date;
}

export type GithubCloneRunner = (deps: GithubCloneExecutionDeps) => Promise<GithubCloneExecutionResult>;

export interface GithubCloneExecutionDeps {
  db?: unknown;
  s3Client?: unknown;
  nangoProxyClient?: unknown;
  githubClient?: unknown;
  relayFileAdapter?: unknown;
  workspaceId?: string;
  // Required by the .relayfile/clone.json sentinel writer (added in #405).
  // Threaded from the SQS payload's `payload.jobId` in the worker.
  jobId?: string;
  request?: GithubCloneJobRequest;
  env?: Record<string, string | undefined>;
  execute?: GithubCloneRunner;
  clone?: GithubCloneRunner;
  cloneRunner?: GithubCloneRunner;
  run?: GithubCloneRunner;
}

function resolveCloneRunner(
  deps: GithubCloneExecutionDeps,
): GithubCloneRunner {
  const runner =
    deps.execute ?? deps.clone ?? deps.cloneRunner ?? deps.run;

  return typeof runner === "function"
    ? runner
    : (resolvedDeps) => runProductionGithubClone(resolvedDeps, resolvedDeps.request as GithubCloneJobRequest);
}

export async function executeGithubClone(
  deps: GithubCloneExecutionDeps,
  request?: GithubCloneJobRequest,
): Promise<GithubCloneExecutionResult> {
  const resolvedRequest = request ?? deps.request;

  if (!resolvedRequest) {
    throw new Error("GitHub clone request is required");
  }

  const runner = resolveCloneRunner(deps);

  return runner({
    ...deps,
    request: resolvedRequest,
    workspaceId: deps.workspaceId ?? resolvedRequest.workspaceId,
  });
}
