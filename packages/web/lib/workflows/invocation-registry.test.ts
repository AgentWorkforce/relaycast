import { describe, expect, it } from "vitest";

import {
  resolveWorkflowGithubWriteGrant,
  resolveWorkflowGithubWriteGrantForRepoAndSlug,
} from "./invocation-registry";

describe("workflow GitHub write grants", () => {
  it("registers proactive issue and Linear chat-lead personas for AgentWorkforce/cloud", () => {
    expect(resolveWorkflowGithubWriteGrant("cloud-small-issue-codex")).toMatchObject({
      slug: "cloud-small-issue-codex",
      owner: "AgentWorkforce",
      repo: "cloud",
      envTokenNames: [],
    });
    expect(resolveWorkflowGithubWriteGrant("cloud-complex-issue-workflow")).toMatchObject({
      slug: "cloud-complex-issue-workflow",
      owner: "AgentWorkforce",
      repo: "cloud",
      envTokenNames: [],
    });
    expect(resolveWorkflowGithubWriteGrant("linear-chat-lead")).toMatchObject({
      slug: "linear-chat-lead",
      owner: "AgentWorkforce",
      repo: "cloud",
      envTokenNames: [],
    });
  });

  it("disambiguates same-repo grants by sponsor slug", () => {
    expect(resolveWorkflowGithubWriteGrantForRepoAndSlug(
      "AgentWorkforce",
      "cloud",
      "cloud-small-issue-codex",
    )).toMatchObject({ slug: "cloud-small-issue-codex" });
    expect(resolveWorkflowGithubWriteGrantForRepoAndSlug(
      "AgentWorkforce",
      "cloud",
      "cloud-complex-issue-workflow",
    )).toMatchObject({ slug: "cloud-complex-issue-workflow" });
    expect(resolveWorkflowGithubWriteGrantForRepoAndSlug(
      "AgentWorkforce",
      "cloud",
      "linear-chat-lead",
    )).toMatchObject({ slug: "linear-chat-lead" });
    expect(resolveWorkflowGithubWriteGrantForRepoAndSlug(
      "AgentWorkforce",
      "cloud",
      "different-persona",
    )).toBeUndefined();
    expect(resolveWorkflowGithubWriteGrantForRepoAndSlug(
      "AgentWorkforce",
      "daily",
      "cloud-complex-issue-workflow",
    )).toBeUndefined();
  });
});
