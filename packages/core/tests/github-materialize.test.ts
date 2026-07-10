import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  githubMaterializeOwnerRootsForMountPaths,
  githubRepoIdentityFromCatalogRow,
  selectGithubReposToMaterialize,
} from "../src/relayfile/github-materialize.js";

describe("github materialize helpers", () => {
  it("extracts only broad GitHub owner roots", () => {
    assert.deepEqual(githubMaterializeOwnerRootsForMountPaths([
      "/github/repos/AgentWorkforce/**",
      "/github/repos/AgentWorkforce/*/pulls/**",
      "/github/repos/acme",
      "/github/repos/acme/cloud/issues/**",
      "/github/repos/acme/cloud/pulls/42__review-me/**",
      "/linear/issues/**",
    ]), ["acme", "AgentWorkforce"]);
  });

  it("derives repo identity from per-owner owner-less rows", () => {
    assert.deepEqual(githubRepoIdentityFromCatalogRow({
      id: "cloud",
      updated: "2026-06-08T12:00:00.000Z",
    }, "AgentWorkforce"), {
      owner: "AgentWorkforce",
      repo: "cloud",
    });
  });

  it("selects recent per-owner rows and top-level fallback rows", () => {
    const selected = selectGithubReposToMaterialize({
      owners: ["AgentWorkforce", "acme"],
      sinceMs: Date.parse("2026-06-01T00:00:00.000Z"),
      rowsByOwner: {
        AgentWorkforce: [
          { id: "cloud", updated: "2026-06-08T12:00:00.000Z" },
          { name: "pear", pushed_at: "2026-05-20T12:00:00.000Z" },
          { id: "missing-updated" },
        ],
        acme: [
          { repo: "billing", updated_at: "2026-06-02T12:00:00.000Z" },
          { id: "ignored/mismatch", updated: "2026-06-02T12:00:00.000Z" },
        ],
      },
      topLevelRows: [
        { id: "AgentWorkforce/cloud", updated: "2026-06-09T12:00:00.000Z" },
        { full_name: "AgentWorkforce/pear", updated_at: "2026-06-04T12:00:00.000Z" },
        { id: "other/repo", updated: "2026-06-04T12:00:00.000Z" },
        { updated: "2026-06-04T12:00:00.000Z" },
      ],
    });

    assert.deepEqual(selected.repos.map((repo) => ({
      owner: repo.owner,
      repo: repo.repo,
      updatedMs: repo.updatedMs,
    })), [
      {
        owner: "AgentWorkforce",
        repo: "cloud",
        updatedMs: Date.parse("2026-06-09T12:00:00.000Z"),
      },
      {
        owner: "AgentWorkforce",
        repo: "pear",
        updatedMs: Date.parse("2026-06-04T12:00:00.000Z"),
      },
      {
        owner: "acme",
        repo: "billing",
        updatedMs: Date.parse("2026-06-02T12:00:00.000Z"),
      },
    ]);
    assert.equal(selected.skippedMissingIdentity, 1);
    assert.equal(selected.skippedMissingUpdated, 1);
  });
});
