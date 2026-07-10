import { describe, expect, it, vi } from "vitest";

import {
  createGitHubLibrarianApiFallback,
  type GitHubIntegration,
} from "./github-api-fallback.js";

function createIntegration(
  overrides: Record<string, unknown> = {},
): GitHubIntegration & { listPulls: ReturnType<typeof vi.fn> } {
  return {
    searchIssues: vi.fn(),
    listAccessibleOrgs: vi.fn(async () => []),
    getRepoExists: vi.fn(async () => false),
    searchRepos: vi.fn(async () => []),
    listPulls: vi.fn(async () => []),
    ...overrides,
  } as GitHubIntegration & { listPulls: ReturnType<typeof vi.fn> };
}

async function runPullFallback(github: GitHubIntegration, repo: string) {
  const fallback = createGitHubLibrarianApiFallback(github);
  return fallback({
    instruction: `Which PRs are open in ${repo}?`,
    text: `open pull requests in ${repo}`,
    filters: {
      repo: [repo],
      state: ["open"],
      type: ["pr"],
    },
    types: ["pr"],
  });
}

describe("createGitHubLibrarianApiFallback", () => {
  it("returns all list API results without filtering by natural-language query text", async () => {
    const listPulls = vi.fn(async () => [
      {
        number: 101,
        title: "Random A",
        body: "Implementation detail only.",
        state: "open",
      },
      {
        number: 102,
        title: "Random B",
        body: "Another unrelated description.",
        state: "open",
      },
    ]);
    const github = createIntegration({ listPulls });

    const entries = await runPullFallback(github, "AgentWorkforce/cloud");

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => JSON.parse(entry.content).title)).toEqual([
      "Random A",
      "Random B",
    ]);
    expect(listPulls).toHaveBeenCalledWith("AgentWorkforce", "cloud", {
      query: "open pull requests in AgentWorkforce/cloud",
      state: "open",
      labels: [],
      limit: 50,
    });
    expect(github.searchIssues).not.toHaveBeenCalled();
  });

  it("single accessible org resolves a bare repo after verifying it exists", async () => {
    const listPulls = vi.fn(async () => [
      {
        number: 101,
        title: "Open PR",
        state: "open",
      },
    ]);
    const github = createIntegration({
      listAccessibleOrgs: vi.fn(async () => ["AgentWorkforce"]),
      getRepoExists: vi.fn(async () => true),
      searchRepos: vi.fn(async () => []),
      listPulls,
    });

    const entries = await runPullFallback(github, "cloud");

    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0].content).repo).toBe("AgentWorkforce/cloud");
    expect(github.listAccessibleOrgs).toHaveBeenCalledTimes(1);
    expect(github.getRepoExists).toHaveBeenCalledWith("AgentWorkforce", "cloud");
    expect(github.searchRepos).not.toHaveBeenCalled();
    expect(listPulls).toHaveBeenCalledWith("AgentWorkforce", "cloud", {
      query: "open pull requests in cloud",
      state: "open",
      labels: [],
      limit: 50,
    });
  });

  it("multiple accessible orgs resolve a bare repo when exactly one exact match exists", async () => {
    const listPulls = vi.fn(async () => [{ number: 12, title: "Only match", state: "open" }]);
    const github = createIntegration({
      listAccessibleOrgs: vi.fn(async () => ["Alpha", "Beta", "Gamma"]),
      getRepoExists: vi.fn(async (owner: string) => owner === "Beta"),
      searchRepos: vi.fn(async () => []),
      listPulls,
    });

    const entries = await runPullFallback(github, "cloud");

    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0].content).repo).toBe("Beta/cloud");
    expect(github.getRepoExists).toHaveBeenCalledWith("Alpha", "cloud");
    expect(github.getRepoExists).toHaveBeenCalledWith("Beta", "cloud");
    expect(github.getRepoExists).toHaveBeenCalledWith("Gamma", "cloud");
    expect(github.searchRepos).not.toHaveBeenCalled();
    expect(listPulls).toHaveBeenCalledWith("Beta", "cloud", expect.any(Object));
  });

  it("multiple exact matches return an ambiguity entry with both candidates", async () => {
    const github = createIntegration({
      listAccessibleOrgs: vi.fn(async () => ["Alpha", "Beta"]),
      getRepoExists: vi.fn(async () => true),
    });

    const entries = await runPullFallback(github, "cloud");

    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe("/_meta/repo-resolution-failed.json");
    expect(entries[0].properties?.warning).toBe("ambiguous_repo_slug");
    expect(entries[0].properties?.reason).toBe("multiple_exact_matches");
    expect(entries[0].properties?.candidates).toBe("Alpha/cloud, Beta/cloud");
    expect(JSON.parse(entries[0].content).candidates).toEqual(["Alpha/cloud", "Beta/cloud"]);
    expect(github.searchIssues).not.toHaveBeenCalled();
    expect(github.listPulls).not.toHaveBeenCalled();
  });

  it("zero accessible orgs return an ambiguity entry instead of calling GitHub list/search", async () => {
    const github = createIntegration({
      listAccessibleOrgs: vi.fn(async () => []),
    });

    const entries = await runPullFallback(github, "cloud");

    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe("/_meta/repo-resolution-failed.json");
    expect(entries[0].properties?.reason).toBe("no_orgs_accessible");
    expect(JSON.parse(entries[0].content).candidates).toEqual([]);
    expect(github.getRepoExists).not.toHaveBeenCalled();
    expect(github.searchRepos).not.toHaveBeenCalled();
    expect(github.listPulls).not.toHaveBeenCalled();
  });

  it("no exact matches invoke fuzzy repo search and return fuzzy candidates", async () => {
    const github = createIntegration({
      listAccessibleOrgs: vi.fn(async () => ["Alpha", "Beta"]),
      getRepoExists: vi.fn(async () => false),
      searchRepos: vi.fn(async () => ["Alpha/cloud-api", "Beta/cloud-web", "Other/cloud"]),
    });

    const entries = await runPullFallback(github, "cloud");

    expect(entries).toHaveLength(1);
    expect(entries[0].properties?.reason).toBe("fuzzy_candidates");
    expect(entries[0].properties?.candidates).toBe("Alpha/cloud-api, Beta/cloud-web");
    expect(JSON.parse(entries[0].content).candidates).toEqual([
      "Alpha/cloud-api",
      "Beta/cloud-web",
    ]);
    expect(github.searchRepos).toHaveBeenCalledWith("cloud", { orgs: ["Alpha", "Beta"] });
    expect(github.listPulls).not.toHaveBeenCalled();
  });

  it("owner/name format is unchanged and avoids resolution API calls", async () => {
    const listPulls = vi.fn(async () => [{ number: 7, title: "Explicit repo", state: "open" }]);
    const github = createIntegration({ listPulls });

    const entries = await runPullFallback(github, "AgentWorkforce/cloud");

    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0].content).repo).toBe("AgentWorkforce/cloud");
    expect(github.listAccessibleOrgs).not.toHaveBeenCalled();
    expect(github.getRepoExists).not.toHaveBeenCalled();
    expect(github.searchRepos).not.toHaveBeenCalled();
    expect(listPulls).toHaveBeenCalledWith("AgentWorkforce", "cloud", expect.any(Object));
  });
});
