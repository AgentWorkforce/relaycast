import {
  GithubCloneStageError,
  toGithubCloneStageError,
} from "./github-clone-stage-error.js";

export type GithubCloneTarImportResult = {
  imported: number;
  errorCount: number;
  errors: Array<{ path: string; code: string; message: string }>;
  skipped: Array<{ path: string; reason: string }>;
  bytesWritten?: number;
};

export type GithubCloneTarImportInput = {
  relayfileUrl: string;
  workspaceId: string;
  owner: string;
  repo: string;
  headSha: string;
  jobId?: string;
  archive: NodeJS.ReadableStream;
  token: () => Promise<string>;
  fetchImpl?: typeof fetch;
};

export type GithubCloneTarFetchImportInput = Omit<
  GithubCloneTarImportInput,
  "archive"
> & {
  ref: string;
  tarballUrl: string;
  githubToken: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
};

export type GithubCloneTarFetchImportJob = {
  jobId: string;
  status: "queued" | "fetching" | "importing" | "completed" | "failed";
  imported?: number;
  errorCount?: number;
  errors?: Array<{ path: string; code: string; message: string }>;
  skipped?: Array<{ path: string; reason: string }>;
  bytesWritten?: number;
  lastError?: string;
};

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export async function importGithubTarballToRelayfile(
  input: GithubCloneTarImportInput,
): Promise<GithubCloneTarImportResult> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const url = new URL(
    `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/fs/import/github-tarball`,
    trimTrailingSlash(input.relayfileUrl),
  );
  url.searchParams.set("owner", input.owner);
  url.searchParams.set("repo", input.repo);
  url.searchParams.set("headSha", input.headSha);
  if (input.jobId) {
    url.searchParams.set("jobId", input.jobId);
  }

  const init = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await input.token()}`,
      "Content-Type": "application/gzip",
      "X-Correlation-Id": input.jobId
        ? `github-clone-job:${input.jobId}:tar-import`
        : `github-clone-${input.workspaceId}-tar-import`,
    },
    body: input.archive as unknown as BodyInit,
    duplex: "half",
  } satisfies RequestInit & { duplex: "half" };

  const response = await fetchImpl(url, init).catch((error) => {
    throw toGithubCloneStageError("relayfile_tar_import_fetch_failed", error);
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new GithubCloneStageError(
      "relayfile_tar_import_failed",
      `Relayfile GitHub tarball import failed (${response.status} ${response.statusText})${bodyText ? `: ${bodyText.slice(0, 500)}` : ""}`,
      { status: response.status },
    );
  }

  let parsed: Partial<GithubCloneTarImportResult>;
  try {
    parsed = bodyText ? (JSON.parse(bodyText) as Partial<GithubCloneTarImportResult>) : {};
  } catch (error) {
    throw toGithubCloneStageError("relayfile_tar_import_failed", error);
  }
  return {
    imported: typeof parsed.imported === "number" ? parsed.imported : 0,
    errorCount: typeof parsed.errorCount === "number" ? parsed.errorCount : 0,
    errors: Array.isArray(parsed.errors) ? parsed.errors : [],
    skipped: Array.isArray(parsed.skipped) ? parsed.skipped : [],
    bytesWritten: parsed.bytesWritten,
  };
}

export async function importGithubTarballByRelayfileFetch(
  input: GithubCloneTarFetchImportInput,
): Promise<GithubCloneTarImportResult> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const requestedJobId = input.jobId ?? crypto.randomUUID();
  const started = await startGithubTarballFetchImport({
    ...input,
    jobId: requestedJobId,
    fetchImpl,
  });
  if (started.status === "completed") {
    return githubTarFetchImportJobResult(started);
  }
  if (started.status === "failed") {
    throw new GithubCloneStageError(
      "relayfile_tar_import_failed",
      started.lastError
        ? `Relayfile GitHub tarball fetch import failed: ${started.lastError}`
        : "Relayfile GitHub tarball fetch import failed.",
    );
  }

  const timeoutMs = input.timeoutMs ?? 14 * 60_000;
  const pollIntervalMs = input.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  let lastPollError = "";
  const relayfileToken = await input.token();
  const correlationId = `github-clone-job:${requestedJobId}:tar-fetch-import`;
  for (;;) {
    let job: GithubCloneTarFetchImportJob;
    try {
      job = await readGithubTarballFetchImportJob({
        fetchImpl,
        relayfileUrl: input.relayfileUrl,
        workspaceId: input.workspaceId,
        jobId: started.jobId,
        token: relayfileToken,
        correlationId,
      });
      lastPollError = "";
    } catch (error) {
      if (!isRetryableImportPollError(error) || Date.now() >= deadline) {
        throw error;
      }
      lastPollError =
        error instanceof Error && error.message ? error.message : String(error);
      await sleep(pollIntervalMs);
      continue;
    }
    if (job.status === "completed") {
      return githubTarFetchImportJobResult(job);
    }
    if (job.status === "failed") {
      throw new GithubCloneStageError(
        "relayfile_tar_import_failed",
        job.lastError
          ? `Relayfile GitHub tarball fetch import failed: ${job.lastError}`
          : "Relayfile GitHub tarball fetch import failed.",
      );
    }
    if (Date.now() >= deadline) {
      throw new GithubCloneStageError(
        "relayfile_tar_import_fetch_failed",
        `Relayfile GitHub tarball fetch import did not complete within ${timeoutMs}ms.${
          lastPollError ? ` Last poll error: ${lastPollError}` : ""
        }`,
      );
    }
    await sleep(pollIntervalMs);
  }
}

export async function startGithubTarballFetchImport(
  input: GithubCloneTarFetchImportInput,
): Promise<GithubCloneTarFetchImportJob> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const jobId = input.jobId ?? crypto.randomUUID();
  const startUrl = new URL(
    `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/fs/import/github-tarball/fetch`,
    trimTrailingSlash(input.relayfileUrl),
  );
  const relayfileToken = await input.token();
  const correlationId = `github-clone-job:${jobId}:tar-fetch-import`;
  const startResponse = await fetchImpl(startUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${relayfileToken}`,
      "Content-Type": "application/json",
      "X-Correlation-Id": correlationId,
      "X-GitHub-Token": input.githubToken,
    },
    body: JSON.stringify({
      owner: input.owner,
      repo: input.repo,
      ref: input.ref,
      headSha: input.headSha,
      jobId,
      tarballUrl: input.tarballUrl,
    }),
  }).catch((error) => {
    throw toGithubCloneStageError("relayfile_tar_import_fetch_failed", error);
  });
  const startBody = await startResponse.text();
  if (!startResponse.ok) {
    throw new GithubCloneStageError(
      "relayfile_tar_import_failed",
      `Relayfile GitHub tarball fetch import start failed (${startResponse.status} ${startResponse.statusText})${startBody ? `: ${startBody.slice(0, 500)}` : ""}`,
      { status: startResponse.status },
    );
  }
  try {
    return JSON.parse(startBody) as GithubCloneTarFetchImportJob;
  } catch (error) {
    throw toGithubCloneStageError("relayfile_tar_import_failed", error);
  }
}

function githubTarFetchImportJobResult(
  job: GithubCloneTarFetchImportJob,
): GithubCloneTarImportResult {
  return {
    imported: typeof job.imported === "number" ? job.imported : 0,
    errorCount: typeof job.errorCount === "number" ? job.errorCount : 0,
    errors: Array.isArray(job.errors) ? job.errors : [],
    skipped: Array.isArray(job.skipped) ? job.skipped : [],
    bytesWritten: job.bytesWritten,
  };
}

function isRetryableImportPollError(error: unknown): boolean {
  const status =
    error instanceof GithubCloneStageError ? error.status : undefined;
  return (
    status === undefined ||
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

async function readGithubTarballFetchImportJob(input: {
  fetchImpl: typeof fetch;
  relayfileUrl: string;
  workspaceId: string;
  jobId: string;
  token: string;
  correlationId: string;
}): Promise<GithubCloneTarFetchImportJob> {
  const url = new URL(
    `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/fs/import/github-tarball/jobs/${encodeURIComponent(input.jobId)}`,
    trimTrailingSlash(input.relayfileUrl),
  );
  const response = await input.fetchImpl(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "X-Correlation-Id": input.correlationId,
    },
  }).catch((error) => {
    throw toGithubCloneStageError("relayfile_tar_import_fetch_failed", error);
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new GithubCloneStageError(
      "relayfile_tar_import_failed",
      `Relayfile GitHub tarball fetch import status failed (${response.status} ${response.statusText})${bodyText ? `: ${bodyText.slice(0, 500)}` : ""}`,
      { status: response.status },
    );
  }
  try {
    return JSON.parse(bodyText) as GithubCloneTarFetchImportJob;
  } catch (error) {
    throw toGithubCloneStageError("relayfile_tar_import_failed", error);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
