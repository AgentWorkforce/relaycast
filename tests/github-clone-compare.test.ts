import { describe, expect, test, vi } from "vitest";

import {
  compareGithubRefs,
  __test__,
} from "../packages/core/src/clone/github-clone-compare";

function makeNango(response: { status?: number; data: unknown }) {
  return {
    proxy: vi.fn().mockResolvedValue({
      status: response.status ?? 200,
      data: response.data,
    }),
  };
}

const baseInput = {
  connectionId: "conn-1",
  providerConfigKey: "github-sage",
  owner: "octo",
  repo: "hello-world",
  base: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
};

describe("compareGithubRefs", () => {
  test("returns no_change for identical refs", async () => {
    const nango = makeNango({ data: { status: "identical", files: [] } });

    const result = await compareGithubRefs({ nango, ...baseInput });

    expect(result).toEqual({ kind: "no_change" });
    expect(nango.proxy).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        endpoint: __test__.buildEndpoint(
          baseInput.owner,
          baseInput.repo,
          baseInput.base,
          baseInput.head,
        ),
        connectionId: "conn-1",
        providerConfigKey: "github-sage",
      }),
    );
  });

  test("returns diverged for diverged status (force-push)", async () => {
    const nango = makeNango({
      data: { status: "diverged", files: [] },
    });

    const result = await compareGithubRefs({ nango, ...baseInput });

    expect(result).toEqual({ kind: "diverged", reason: "force_push" });
  });

  test("returns diverged for behind status", async () => {
    const nango = makeNango({
      data: { status: "behind", files: [] },
    });

    const result = await compareGithubRefs({ nango, ...baseInput });

    expect(result).toEqual({ kind: "diverged", reason: "behind" });
  });

  test("returns truncated when files count hits the 300-cap", async () => {
    const files = Array.from({ length: __test__.GITHUB_COMPARE_FILES_CAP }, (_, i) => ({
      filename: `path/${i}.txt`,
      status: "modified",
      sha: `sha-${i}`,
    }));
    const nango = makeNango({
      data: { status: "ahead", files },
    });

    const result = await compareGithubRefs({ nango, ...baseInput });

    expect(result).toEqual({
      kind: "truncated",
      totalChangedFiles: __test__.GITHUB_COMPARE_FILES_CAP,
    });
  });

  test("returns mapped changes for ahead status with mixed file statuses", async () => {
    const resolvedHeadSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const nango = makeNango({
      data: {
        status: "ahead",
        commits: [
          { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
          { sha: resolvedHeadSha },
        ],
        files: [
          { filename: "a.txt", status: "added", sha: "sha-a" },
          { filename: "b.ts", status: "modified", sha: "sha-b" },
          { filename: "c.md", status: "removed" },
          { filename: "d.json", status: "renamed", sha: "sha-d", previous_filename: "d-old.json" },
          // 'changed' is mapped to 'modified' (executor writes the new blob).
          { filename: "e.yaml", status: "changed", sha: "sha-e" },
          // missing sha + status=modified → dropped (no way to fetch blob).
          { filename: "f.bin", status: "modified" },
        ],
      },
    });

    const result = await compareGithubRefs({ nango, ...baseInput });

    expect(result).toEqual({
      kind: "changes",
      headSha: resolvedHeadSha,
      files: [
        { status: "added", path: "a.txt", sha: "sha-a" },
        { status: "modified", path: "b.ts", sha: "sha-b" },
        { status: "removed", path: "c.md" },
        { status: "renamed", path: "d.json", previousPath: "d-old.json", sha: "sha-d" },
        { status: "modified", path: "e.yaml", sha: "sha-e" },
      ],
    });
  });

  test("uses the resolved compare head sha instead of echoing a branch ref", async () => {
    const nango = makeNango({
      data: {
        status: "ahead",
        commits: [{ sha: "resolved-head-sha" }],
        files: [{ filename: "a.txt", status: "modified", sha: "sha-a" }],
      },
    });

    const result = await compareGithubRefs({
      nango,
      ...baseInput,
      head: "main",
    });

    expect(result).toEqual({
      kind: "changes",
      headSha: "resolved-head-sha",
      files: [{ status: "modified", path: "a.txt", sha: "sha-a" }],
    });
  });

  test("throws for ahead responses without a resolved head sha", async () => {
    const nango = makeNango({
      data: {
        status: "ahead",
        files: [{ filename: "a.txt", status: "modified", sha: "sha-a" }],
      },
    });

    await expect(compareGithubRefs({ nango, ...baseInput, head: "main" })).rejects.toThrow(
      /resolved head commit sha/,
    );
  });

  test("treats unknown status as diverged so caller falls back to full clone", async () => {
    const nango = makeNango({
      data: { status: "wat", files: [] },
    });

    const result = await compareGithubRefs({ nango, ...baseInput });

    expect(result).toEqual({ kind: "diverged", reason: "non_ancestor" });
  });

  test("throws when proxy returns a non-object body", async () => {
    const nango = makeNango({ data: null });

    await expect(compareGithubRefs({ nango, ...baseInput })).rejects.toThrow(
      /returned a non-object body/,
    );
  });
});
