export const GITHUB_CODELOAD_TTL_MS = 5 * 60 * 1000;

export type GithubArchiveLeaseStage =
  | "github_app_token_resolve"
  | "ref_resolve_failed"
  | "github_tarball_redirect";

export class GithubArchiveLeaseError extends Error {
  readonly stage: GithubArchiveLeaseStage;
  readonly upstreamStatus?: number;

  constructor(
    message: string,
    stage: GithubArchiveLeaseStage,
    upstreamStatus?: number,
  ) {
    super(message);
    this.name = "GithubArchiveLeaseError";
    this.stage = stage;
    this.upstreamStatus = upstreamStatus;
  }
}

export type MintGithubArchiveCodeloadUrlInput = {
  owner: string;
  repo: string;
  headSha: string;
  installationToken: string;
  fetchImpl?: typeof globalThis.fetch;
  nowMs?: number;
};

export type GithubArchiveCodeloadLease = {
  url: string;
  expiresAt: string;
  sha: string;
};

export type ResolveGithubRefToShaInput = {
  owner: string;
  repo: string;
  ref: string;
  installationToken: string;
  fetchImpl?: typeof globalThis.fetch;
};

export async function resolveGithubRefToSha(
  input: ResolveGithubRefToShaInput,
): Promise<string> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const upstreamUrl = `https://api.github.com/repos/${encodeURIComponent(
    input.owner,
  )}/${encodeURIComponent(input.repo)}/commits/${encodeURIComponent(
    input.ref,
  )}`;

  const response = await fetchImpl(upstreamUrl, {
    method: "GET",
    headers: {
      Authorization: `token ${input.installationToken}`,
      "User-Agent": "AgentWorkforce-Cloud-Clone-Archive-Lease",
      Accept: "application/vnd.github.sha",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    throw new GithubArchiveLeaseError(
      "github ref resolve failed",
      "ref_resolve_failed",
      response.status,
    );
  }

  const sha = (await response.text()).trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new GithubArchiveLeaseError(
      "github ref resolve returned an invalid sha",
      "ref_resolve_failed",
      response.status,
    );
  }
  return sha;
}

export async function mintGithubArchiveCodeloadUrl(
  input: MintGithubArchiveCodeloadUrlInput,
): Promise<GithubArchiveCodeloadLease> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const upstreamUrl = `https://api.github.com/repos/${encodeURIComponent(
    input.owner,
  )}/${encodeURIComponent(input.repo)}/tarball/${encodeURIComponent(
    input.headSha,
  )}`;

  const response = await fetchImpl(upstreamUrl, {
    method: "GET",
    redirect: "manual",
    headers: {
      Authorization: `token ${input.installationToken}`,
      "User-Agent": "AgentWorkforce-Cloud-Clone-Archive-Lease",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (response.status !== 302) {
    throw new GithubArchiveLeaseError(
      "github tarball endpoint did not redirect",
      "github_tarball_redirect",
      response.status,
    );
  }

  const location = response.headers.get("location");
  if (!location || !location.startsWith("https://codeload.github.com/")) {
    throw new GithubArchiveLeaseError(
      "github tarball redirect missing codeload Location",
      "github_tarball_redirect",
      response.status,
    );
  }

  const nowMs = input.nowMs ?? Date.now();
  return {
    url: location,
    expiresAt: new Date(nowMs + GITHUB_CODELOAD_TTL_MS).toISOString(),
    sha: input.headSha,
  };
}
