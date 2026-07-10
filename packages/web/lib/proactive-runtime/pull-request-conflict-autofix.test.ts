import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONFLICT_AUTOFIX_EXIT,
  buildConflictAutofixComment,
  buildPullRequestRebaseScript,
  classifyPullRequestMergeState,
  isSafeGitRefName,
  pollPullRequestMergeableState,
} from "./pull-request-conflict-autofix.js";

// ---------------------------------------------------------------------------
// classifier
// ---------------------------------------------------------------------------

function prPayload(overrides: {
  mergeable_state?: string;
  mergeable?: boolean | null;
  headRef?: string;
  baseRef?: string;
  number?: number;
  fork?: boolean;
  action?: string;
}): unknown {
  const baseFull = "AgentWorkforce/cloud";
  const headFull = overrides.fork ? "contributor/cloud" : baseFull;
  return {
    action: overrides.action ?? "synchronize",
    repository: {
      name: "cloud",
      full_name: baseFull,
      owner: { login: "AgentWorkforce" },
    },
    pull_request: {
      number: overrides.number ?? 1234,
      mergeable: overrides.mergeable === undefined ? true : overrides.mergeable,
      mergeable_state: overrides.mergeable_state,
      head: {
        ref: overrides.headRef ?? "feature/widget",
        sha: "a".repeat(40),
        repo: { full_name: headFull },
      },
      base: {
        ref: overrides.baseRef ?? "main",
        sha: "b".repeat(40),
        repo: { full_name: baseFull, name: "cloud", owner: { login: "AgentWorkforce" } },
      },
    },
  };
}

describe("classifyPullRequestMergeState", () => {
  it("flags a dirty non-fork PR for conflict autofix", () => {
    const result = classifyPullRequestMergeState(
      prPayload({ mergeable_state: "dirty", mergeable: false }),
    );
    expect(result.state).toBe("dirty");
    expect(result.needsConflictAutofix).toBe(true);
    expect(result.needsPoll).toBe(false);
    expect(result.owner).toBe("AgentWorkforce");
    expect(result.repo).toBe("cloud");
    expect(result.number).toBe(1234);
    expect(result.headRef).toBe("feature/widget");
    expect(result.baseRef).toBe("main");
  });

  it("does NOT autofix a clean PR", () => {
    const result = classifyPullRequestMergeState(
      prPayload({ mergeable_state: "clean", mergeable: true }),
    );
    expect(result.state).toBe("clean");
    expect(result.needsConflictAutofix).toBe(false);
  });

  it("does NOT autofix a PR that is merely behind (no conflict)", () => {
    const result = classifyPullRequestMergeState(
      prPayload({ mergeable_state: "behind", mergeable: true }),
    );
    expect(result.state).toBe("behind");
    expect(result.needsConflictAutofix).toBe(false);
  });

  it("refuses to autofix a fork PR even when dirty (cannot push to a fork head)", () => {
    const result = classifyPullRequestMergeState(
      prPayload({ mergeable_state: "dirty", mergeable: false, fork: true }),
    );
    expect(result.fromFork).toBe(true);
    expect(result.needsConflictAutofix).toBe(false);
  });

  it("signals needsPoll when mergeability is unknown / not yet computed", () => {
    const result = classifyPullRequestMergeState(
      prPayload({ mergeable_state: "unknown", mergeable: null }),
    );
    expect(result.state).toBe("unknown");
    expect(result.needsPoll).toBe(true);
    expect(result.needsConflictAutofix).toBe(false);
  });

  it("falls back to the mergeable boolean when mergeable_state is absent", () => {
    const result = classifyPullRequestMergeState(prPayload({ mergeable: false }));
    expect(result.state).toBe("dirty");
    expect(result.needsConflictAutofix).toBe(true);
  });

  it("refuses to autofix a dirty PR with an unsafe head ref", () => {
    const result = classifyPullRequestMergeState(
      prPayload({ mergeable_state: "dirty", mergeable: false, headRef: "../evil" }),
    );
    expect(result.needsConflictAutofix).toBe(false);
  });

  it("fails safe to fork (no autofix) when repo metadata can't confirm same-repo", () => {
    // No head.repo.full_name and no repository → cannot confirm same-repo.
    const result = classifyPullRequestMergeState({
      action: "synchronize",
      pull_request: {
        number: 5,
        mergeable: false,
        mergeable_state: "dirty",
        head: { ref: "feature", sha: "a".repeat(40) },
        base: { ref: "main", sha: "b".repeat(40) },
      },
    });
    expect(result.fromFork).toBe(true);
    expect(result.needsConflictAutofix).toBe(false);
  });

  it("resolves owner/repo from a same-repo full_name and stays actionable", () => {
    const result = classifyPullRequestMergeState({
      action: "synchronize",
      pull_request: {
        number: 5,
        mergeable: false,
        mergeable_state: "dirty",
        head: { ref: "feature", sha: "a".repeat(40), repo: { full_name: "x/y" } },
        base: { ref: "main", sha: "b".repeat(40), repo: { full_name: "x/y" } },
      },
    });
    expect(result.fromFork).toBe(false);
    expect(result.owner).toBe("x");
    expect(result.repo).toBe("y");
    expect(result.needsConflictAutofix).toBe(true);
  });
});

describe("isSafeGitRefName", () => {
  it("accepts normal branch names", () => {
    expect(isSafeGitRefName("main")).toBe(true);
    expect(isSafeGitRefName("feature/widget-1")).toBe(true);
  });
  it("rejects traversal, option-injection and ref-spec metacharacters", () => {
    for (const bad of ["../evil", "-x", "a..b", "a@{0}", "/leading", "trailing/", "a//b", "a b", "$(rm)"]) {
      expect(isSafeGitRefName(bad)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// poll (eventual consistency)
// ---------------------------------------------------------------------------

describe("pollPullRequestMergeableState", () => {
  it("does not trust the first read: keeps polling while unknown, then settles", async () => {
    const probes = [
      { mergeable: null, mergeable_state: "unknown" },
      { mergeable: null, mergeable_state: "unknown" },
      { mergeable: false, mergeable_state: "dirty", headSha: "c".repeat(40) },
    ];
    let calls = 0;
    const result = await pollPullRequestMergeableState({
      fetchPullRequest: async () => probes[calls++] ?? null,
      maxAttempts: 5,
      sleep: async () => {},
    });
    expect(result.attempts).toBe(3);
    expect(result.settled).toBe(true);
    expect(result.state).toBe("dirty");
    expect(result.headSha).toBe("c".repeat(40));
  });

  it("gives up after maxAttempts when the state never settles", async () => {
    let calls = 0;
    const result = await pollPullRequestMergeableState({
      fetchPullRequest: async () => {
        calls += 1;
        return { mergeable: null, mergeable_state: "unknown" };
      },
      maxAttempts: 4,
      sleep: async () => {},
    });
    expect(calls).toBe(4);
    expect(result.attempts).toBe(4);
    expect(result.settled).toBe(false);
    expect(result.state).toBe("unknown");
  });

  it("ends as unavailable when the PR disappears", async () => {
    const result = await pollPullRequestMergeableState({
      fetchPullRequest: async () => null,
      sleep: async () => {},
    });
    expect(result.state).toBe("unavailable");
    expect(result.settled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// rebase shell — static safety assertions
// ---------------------------------------------------------------------------

const baseConfig = {
  owner: "AgentWorkforce",
  repo: "cloud",
  number: 1234,
  baseBranch: "main",
  headRef: "feature/widget",
  expectedHeadSha: "a".repeat(40),
  remoteUrl: "https://github.com/AgentWorkforce/cloud.git",
};

describe("buildPullRequestRebaseScript — safety gates (static)", () => {
  it("pushes ONLY with --force-with-lease, never a plain force", () => {
    const script = buildPullRequestRebaseScript(baseConfig);
    expect(script).toContain("--force-with-lease=");
    // no unguarded force anywhere
    expect(script).not.toMatch(/git push[^\n]*--force(?![-_])/);
    expect(script).not.toMatch(/git push[^\n]*(\s|=)-f(\s|$)/);
  });

  it("anchors the lease to the expected head sha observed at detection time", () => {
    const script = buildPullRequestRebaseScript(baseConfig);
    expect(script).toContain(`--force-with-lease='feature/widget:${"a".repeat(40)}'`);
  });

  it("rebases onto the base branch only (origin/<base>), fetching base + head only", () => {
    const script = buildPullRequestRebaseScript(baseConfig);
    expect(script).toContain("git fetch --no-tags --force origin '+refs/heads/main:refs/remotes/origin/main'");
    expect(script).toContain("git fetch --no-tags --force origin '+refs/heads/feature/widget:refs/remotes/origin/feature/widget'");
    expect(script).toContain("rebase 'refs/remotes/origin/main'");
    // never a blanket fetch of all refs
    expect(script).not.toContain("git fetch --all");
  });

  it("aborts the rebase on conflict and does not push", () => {
    const script = buildPullRequestRebaseScript(baseConfig);
    expect(script).toContain("git rebase --abort");
    expect(script).toContain("CONFLICT_AUTOFIX_OUTCOME=conflict");
    // the push block is gated on the rebased outcome
    expect(script).toContain('if [ "$CONFLICT_AUTOFIX_OUTCOME" = rebased ]; then');
  });

  it("gates the rebase on a successful checkout (never rebases a stray branch)", () => {
    const script = buildPullRequestRebaseScript(baseConfig);
    expect(script).toContain("if git checkout --force -B pr-autofix 'refs/remotes/origin/feature/widget'; then");
    expect(script).toContain("failed to check out PR head");
  });

  it("refuses to push when the remote head advanced past the expected sha", () => {
    const script = buildPullRequestRebaseScript(baseConfig);
    expect(script).toContain("CONFLICT_AUTOFIX_OUTCOME=head-advanced");
    expect(script).toContain('if [ "$REMOTE_HEAD_BEFORE" != "$EXPECTED_REMOTE_HEAD" ]; then');
  });

  it("throws on unsafe refs / shas instead of emitting an injectable script", () => {
    expect(() => buildPullRequestRebaseScript({ ...baseConfig, headRef: "../evil" })).toThrow();
    expect(() => buildPullRequestRebaseScript({ ...baseConfig, baseBranch: "-x" })).toThrow();
    expect(() => buildPullRequestRebaseScript({ ...baseConfig, expectedHeadSha: "$(rm -rf /)" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// rebase shell — executable behaviour against real git repos
// ---------------------------------------------------------------------------

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

const tmpRoots: string[] = [];
function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "s6-autofix-"));
  tmpRoots.push(root);
  return root;
}

afterEach(() => {
  while (tmpRoots.length) {
    const root = tmpRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Build a bare "remote" with a `main` branch and a `feature` branch that
 * diverged from a common ancestor. `conflicting` controls whether `feature`
 * edits the same file `main` later changed (→ rebase conflict) or a different
 * file (→ clean rebase). Returns the remote path and the feature head sha.
 */
function seedRemote(opts: { conflicting: boolean }): { remote: string; featureSha: string } {
  const root = tmpRoot();
  const remote = join(root, "remote.git");
  mkdirSync(remote, { recursive: true });
  git(remote, ["init", "--bare", "-q"]);

  const seed = join(root, "seed");
  mkdirSync(seed, { recursive: true });
  git(seed, ["init", "-q"]);
  // common ancestor on main
  writeFileSync(join(seed, "file.txt"), "base v1\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "c0"]);
  git(seed, ["branch", "-M", "main"]);

  // feature diverges from the ancestor
  git(seed, ["checkout", "-q", "-b", "feature"]);
  if (opts.conflicting) {
    writeFileSync(join(seed, "file.txt"), "feature edit\n");
  } else {
    writeFileSync(join(seed, "other.txt"), "feature only\n");
  }
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "feature work"]);
  const featureSha = git(seed, ["rev-parse", "HEAD"]);

  // main advances, editing file.txt (conflicts with feature's edit in the
  // conflicting case; orthogonal in the clean case)
  git(seed, ["checkout", "-q", "main"]);
  writeFileSync(join(seed, "file.txt"), "base v2\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "base advance"]);

  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "-q", "origin", "main", "feature"]);
  return { remote, featureSha };
}

function runScript(script: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync("sh", ["-c", script], { env: GIT_ENV, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function remoteSha(remote: string, ref: string): string {
  return git(remote, ["rev-parse", ref]);
}

describe("buildPullRequestRebaseScript — executable behaviour", () => {
  it("rebases a cleanly-rebasable dirty PR and force-with-lease pushes it", () => {
    const { remote, featureSha } = seedRemote({ conflicting: false });
    const ws = join(tmpRoot(), "ws");
    const script = buildPullRequestRebaseScript({
      ...baseConfig,
      headRef: "feature",
      expectedHeadSha: featureSha,
      remoteUrl: `file://${remote}`,
      workspaceDir: ws,
      exitAtEnd: true,
    });

    const before = remoteSha(remote, "feature");
    const result = runScript(script);

    expect(result.stdout).toContain("CONFLICT_AUTOFIX_OUTCOME=pushed");
    expect(result.status).toBe(CONFLICT_AUTOFIX_EXIT.OK);

    const after = remoteSha(remote, "feature");
    expect(after).not.toBe(before); // branch was updated...
    // ...and it now sits on top of main (parent == main tip), with both edits
    const mainTip = remoteSha(remote, "main");
    expect(git(remote, ["rev-parse", "feature^"])).toBe(mainTip);
    const fileAtFeature = git(remote, ["show", "feature:file.txt"]);
    expect(fileAtFeature).toBe("base v2");
    expect(git(remote, ["show", "feature:other.txt"])).toBe("feature only");
  });

  it("aborts on a real conflict and leaves the remote branch untouched", () => {
    const { remote, featureSha } = seedRemote({ conflicting: true });
    const ws = join(tmpRoot(), "ws");
    const script = buildPullRequestRebaseScript({
      ...baseConfig,
      headRef: "feature",
      expectedHeadSha: featureSha,
      remoteUrl: `file://${remote}`,
      workspaceDir: ws,
      exitAtEnd: true,
    });

    const before = remoteSha(remote, "feature");
    const result = runScript(script);

    expect(result.stdout).toContain("CONFLICT_AUTOFIX_OUTCOME=conflict");
    expect(result.status).toBe(CONFLICT_AUTOFIX_EXIT.CONFLICT);
    // CRITICAL: nothing was pushed — the contributor's branch is intact.
    expect(remoteSha(remote, "feature")).toBe(before);
    expect(remoteSha(remote, "feature")).toBe(featureSha);
  });

  it("refuses to clobber a branch whose head advanced after detection", () => {
    const { remote, featureSha } = seedRemote({ conflicting: false });
    const ws = join(tmpRoot(), "ws");

    // Simulate a concurrent push advancing the feature branch AFTER we recorded
    // featureSha as the expected head.
    const bump = join(tmpRoot(), "bump");
    mkdirSync(bump, { recursive: true });
    git(bump, ["clone", "-q", "--branch", "feature", `file://${remote}`, "."]);
    writeFileSync(join(bump, "concurrent.txt"), "someone else\n");
    git(bump, ["add", "-A"]);
    git(bump, ["commit", "-q", "-m", "concurrent push"]);
    git(bump, ["push", "-q", "origin", "feature"]);
    const advancedSha = remoteSha(remote, "feature");
    expect(advancedSha).not.toBe(featureSha);

    const script = buildPullRequestRebaseScript({
      ...baseConfig,
      headRef: "feature",
      expectedHeadSha: featureSha, // stale anchor
      remoteUrl: `file://${remote}`,
      workspaceDir: ws,
      exitAtEnd: true,
    });
    const result = runScript(script);

    expect(result.stdout).toContain("CONFLICT_AUTOFIX_OUTCOME=head-advanced");
    expect(result.status).toBe(CONFLICT_AUTOFIX_EXIT.HEAD_ADVANCED);
    // The newer commit is preserved.
    expect(remoteSha(remote, "feature")).toBe(advancedSha);
  });
});

// ---------------------------------------------------------------------------
// comment builder
// ---------------------------------------------------------------------------

describe("buildConflictAutofixComment", () => {
  it("returns null on the happy path (rebase pushed)", () => {
    expect(buildConflictAutofixComment({ outcome: "pushed", number: 1, baseBranch: "main", headRef: "f" })).toBeNull();
  });
  it("explains a conflict with manual rebase instructions", () => {
    const body = buildConflictAutofixComment({ outcome: "conflict", number: 7, baseBranch: "main", headRef: "feat" });
    expect(body).toContain("couldn't rebase");
    expect(body).toContain("git rebase origin/main");
    expect(body).toContain("--force-with-lease");
  });
  it("notes a head-advanced skip without alarm", () => {
    const body = buildConflictAutofixComment({ outcome: "head-advanced", number: 7, baseBranch: "main", headRef: "feat" });
    expect(body).toContain("the branch moved");
  });
});
