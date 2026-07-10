import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  and: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
  getDb: vi.fn(),
  isGithubInstallationCentricEnabled: vi.fn(),
  normalizeGithubRepositoryCoord: vi.fn(),
  resolveGithubConnectionForWorkspace: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  and: mocks.and,
  eq: mocks.eq,
  inArray: mocks.inArray,
}));

vi.mock("../db", () => ({
  getDb: mocks.getDb,
}));

vi.mock("../db/schema", () => ({
  githubInstallations: {
    installationId: "github_installations.installation_id",
    accountLogin: "github_installations.account_login",
    accountId: "github_installations.account_id",
    accountType: "github_installations.account_type",
  },
  repoGithubInstallationIndex: {
    workspaceId: "repo_github_installation_index.workspace_id",
    repoOwner: "repo_github_installation_index.repo_owner",
    repoName: "repo_github_installation_index.repo_name",
    installationId: "repo_github_installation_index.installation_id",
    accessState: "repo_github_installation_index.access_state",
  },
  workspaceGithubInstallationLinks: {
    workspaceId: "workspace_github_installation_links.workspace_id",
    installationId: "workspace_github_installation_links.installation_id",
    connectionId: "workspace_github_installation_links.connection_id",
    providerConfigKey: "workspace_github_installation_links.provider_config_key",
  },
}));

vi.mock("./github-installation-index", () => ({
  normalizeGithubRepositoryCoord: mocks.normalizeGithubRepositoryCoord,
}));

vi.mock("./github-installation-centric-flag", () => ({
  isGithubInstallationCentricEnabled: mocks.isGithubInstallationCentricEnabled,
}));

vi.mock("./github-installation-connection", () => ({
  resolveGithubConnectionForWorkspace: mocks.resolveGithubConnectionForWorkspace,
}));

import { resolveGithubAuthShadow } from "./github-auth-resolver";

function selectChain(result: unknown[]) {
  const whereResult = Promise.resolve(result) as Promise<unknown[]> & {
    limit: (count: number) => Promise<unknown[]>;
  };
  whereResult.limit = async () => result;
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => whereResult),
    })),
  };
}

function dbWithSelectResults(...results: unknown[][]) {
  let index = 0;
  return {
    select: vi.fn(() => selectChain(results[index++] ?? [])),
  };
}

describe("resolveGithubAuthShadow installation-centric flag", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.eq.mockImplementation((left: unknown, right: unknown) => ({
      op: "eq",
      left,
      right,
    }));
    mocks.and.mockImplementation((...conditions: unknown[]) => ({
      op: "and",
      conditions,
    }));
    mocks.inArray.mockImplementation((left: unknown, right: unknown) => ({
      op: "inArray",
      left,
      right,
    }));
    mocks.normalizeGithubRepositoryCoord.mockImplementation((value: string) =>
      value.toLowerCase(),
    );
    mocks.isGithubInstallationCentricEnabled.mockReturnValue(false);
    mocks.resolveGithubConnectionForWorkspace.mockResolvedValue({
      installationId: "inst-123",
      connectionId: "conn-installation",
      providerConfigKey: "github-relay",
      accountLogin: "AgentWorkforce",
      accountType: "Organization",
      repositorySelection: "selected",
      suspended: false,
      source: "org-installation",
    });
  });

  it("does not consult the installation resolver when the flag is off", async () => {
    mocks.getDb.mockReturnValue(dbWithSelectResults([], []));

    const result = await resolveGithubAuthShadow({
      workspaceId: "workspace-1",
      owner: "AgentWorkforce",
      repo: "cloud",
      purpose: "workflow_write",
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "missing_installation",
    });
    expect(mocks.resolveGithubConnectionForWorkspace).not.toHaveBeenCalled();
  });

  it("uses the installation resolver as the linked installation source when the flag is on", async () => {
    mocks.isGithubInstallationCentricEnabled.mockReturnValue(true);
    mocks.getDb.mockReturnValue(dbWithSelectResults([
      {
        installationId: "inst-123",
        accessState: "active",
      },
    ]));

    const result = await resolveGithubAuthShadow({
      workspaceId: "workspace-1",
      owner: "AgentWorkforce",
      repo: "cloud",
      purpose: "workflow_write",
    });

    expect(result).toEqual({
      ok: true,
      tokenType: "installation",
      authKind: "app_installation",
      installationId: "inst-123",
      accountLogin: "AgentWorkforce",
      accountType: "Organization",
      matchedBy: "repository_index",
      connectionId: "conn-installation",
      providerConfigKey: "github-relay",
    });
    expect(mocks.resolveGithubConnectionForWorkspace).toHaveBeenCalledWith(
      "workspace-1",
    );
  });
});
