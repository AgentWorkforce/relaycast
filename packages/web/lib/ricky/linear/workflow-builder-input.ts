export type LinearRepoTarget = {
  installationId?: string;
  owner: string;
  repo: string;
  repositoryId: string;
};

const GITHUB_INSTALL_RE = /^github-install:\/\/([^/]+)\/([^/]+)\/([^/]+)$/i;
const OWNER_REPO_RE = /(?:^|[\s([`])(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:[\s)\]`,.:;]|$)/;

export function parseGitHubInstallRepositoryId(value: string | null | undefined): LinearRepoTarget | null {
  const match = value?.trim().match(GITHUB_INSTALL_RE);
  if (!match) return null;
  const [, installationId, owner, repo] = match;
  return {
    installationId,
    owner,
    repo,
    repositoryId: `github-install://${installationId}/${owner}/${repo}`,
  };
}

export function parseRepoTargetFromText(text: string | null | undefined): LinearRepoTarget | null {
  const match = text?.match(OWNER_REPO_RE);
  if (!match) return null;
  const [, owner, rawRepo] = match;
  const repo = rawRepo.replace(/[.,;:]+$/, "");
  return {
    owner,
    repo,
    repositoryId: `${owner}/${repo}`,
  };
}

export function buildLinearWorkflow(input: {
  issueTitle: string;
  issueBody: string;
  promptContext?: string;
  repoTarget: LinearRepoTarget;
  connectedAgentCli: string;
}): string {
  const prompt = [
    `Linear issue: ${input.issueTitle}`,
    "",
    input.issueBody,
    input.promptContext ? `\nContext:\n${input.promptContext}` : "",
    "",
    `Open a GitHub PR against ${input.repoTarget.owner}/${input.repoTarget.repo}.`,
  ].join("\n");

  return JSON.stringify({
    version: "1.0",
    name: "ricky-linear-agent-session",
    pattern: "pipeline",
    agents: [
      {
        id: "implementer",
        role: "worker",
        cli: input.connectedAgentCli,
      },
    ],
    steps: [
      {
        id: "implement",
        agent: "implementer",
        prompt,
        expects: "A pull request URL or a clear blocker summary.",
      },
    ],
  });
}
