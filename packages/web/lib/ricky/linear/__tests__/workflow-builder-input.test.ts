import { describe, expect, it } from "vitest";
import {
  parseGitHubInstallRepositoryId,
  parseRepoTargetFromText,
} from "../workflow-builder-input";

describe("Linear repo target parsing", () => {
  it("resolves owner/repo mentions from issue text", () => {
    expect(parseRepoTargetFromText("Please fix this in AgentWorkforce/cloud.")).toEqual({
      owner: "AgentWorkforce",
      repo: "cloud",
      repositoryId: "AgentWorkforce/cloud",
    });
  });

  it("resolves workspace default repository IDs", () => {
    expect(parseGitHubInstallRepositoryId("github-install://123/AgentWorkforce/cloud")).toEqual({
      installationId: "123",
      owner: "AgentWorkforce",
      repo: "cloud",
      repositoryId: "github-install://123/AgentWorkforce/cloud",
    });
  });
});
