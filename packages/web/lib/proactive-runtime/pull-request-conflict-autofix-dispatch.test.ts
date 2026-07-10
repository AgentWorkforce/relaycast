import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONFLICT_AUTOFIX_BOT_LOGIN,
  CONFLICT_AUTOFIX_EXIT,
  CONFLICT_AUTOFIX_GIT_TOKEN_ENV,
  CONFLICT_AUTOFIX_WATCH_RULES,
  CONFLICT_RESOLVE_WATCH_RULES,
  buildConflictAutofixGitAuth,
  buildConflictAutofixInvokeScript,
  buildConflictAutofixSandboxScript,
  conflictAutofixOutcomeIsSuccess,
  isConflictAutofixPersona,
  isConflictResolvePersona,
  matchesConflictResolveDirective,
  parseConflictAutofixOutcome,
  resolveConflictAutofixPlan,
  type ConflictAutofixPlan,
} from "./pull-request-conflict-autofix-dispatch.js";
import {
  parseWatchRules,
  watchRulesMatchEvent,
} from "@cloud/core/proactive-runtime/match.js";

// ---------------------------------------------------------------------------
// capability gate (dormant safety)
// ---------------------------------------------------------------------------

describe("isConflictAutofixPersona", () => {
  it("is false for a persona without the capability (dormant by default)", () => {
    expect(isConflictAutofixPersona({})).toBe(false);
    expect(isConflictAutofixPersona({ capabilities: {} })).toBe(false);
    expect(isConflictAutofixPersona({ capabilities: { pullRequest: true } })).toBe(false);
    expect(isConflictAutofixPersona(null)).toBe(false);
    expect(isConflictAutofixPersona("nope")).toBe(false);
  });

  it("is true when conflictAutofix is enabled", () => {
    expect(isConflictAutofixPersona({ capabilities: { conflictAutofix: true } })).toBe(true);
    expect(
      isConflictAutofixPersona({ capabilities: { conflictAutofix: { enabled: true } } }),
    ).toBe(true);
    // bare object opts in (mirrors hasPullRequestCapability)
    expect(isConflictAutofixPersona({ capabilities: { conflictAutofix: {} } })).toBe(true);
  });

  it("respects an explicit opt-out", () => {
    expect(
      isConflictAutofixPersona({ capabilities: { conflictAutofix: { enabled: false } } }),
    ).toBe(false);
  });
});

describe("conflictResolve capability and directive gate", () => {
  it("is dormant unless the conflictResolve capability is enabled", () => {
    expect(isConflictResolvePersona({})).toBe(false);
    expect(isConflictResolvePersona({ capabilities: { pullRequest: true } })).toBe(false);
    expect(isConflictResolvePersona({ capabilities: { conflictResolve: true } })).toBe(true);
    expect(isConflictResolvePersona({ capabilities: { conflictResolve: {} } })).toBe(true);
    expect(
      isConflictResolvePersona({ capabilities: { conflictResolve: { enabled: false } } }),
    ).toBe(false);
  });

  it("matches only adjacent @relay conflict-resolution directives", () => {
    expect(matchesConflictResolveDirective("@relay fix conflicts")).toBe(true);
    expect(matchesConflictResolveDirective("please @relay resolve conflicts now")).toBe(true);
    expect(matchesConflictResolveDirective("@relay fix the conflicts")).toBe(false);
    expect(matchesConflictResolveDirective("@relay please fix conflicts")).toBe(false);
    expect(matchesConflictResolveDirective("@relay fix conflict")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// watch rules
// ---------------------------------------------------------------------------

describe("CONFLICT_AUTOFIX_WATCH_RULES", () => {
  const rules = parseWatchRules(CONFLICT_AUTOFIX_WATCH_RULES);

  it("round-trips through parseWatchRules with conditions intact", () => {
    expect(rules).toHaveLength(1);
    expect(rules[0]?.conditions?.[0]?.field).toBe("action");
    expect(rules[0]?.conditions?.[0]?.in).toContain("synchronize");
  });

  it("matches a synchronize PR event on a PR path", () => {
    expect(
      watchRulesMatchEvent(
        rules,
        "pull_request.synchronize",
        ["/github/repos/AgentWorkforce/cloud/pulls/42"],
        { action: "synchronize" },
      ),
    ).toBe(true);
  });

  it("does not match an unrelated PR sub-event (labeled)", () => {
    // The event isn't in `events`, and even if it were the `action` condition
    // filters it out.
    expect(
      watchRulesMatchEvent(
        rules,
        "pull_request.labeled",
        ["/github/repos/AgentWorkforce/cloud/pulls/42"],
        { action: "labeled" },
      ),
    ).toBe(false);
  });

  it("does not match a non-pull_request event type (e.g. issues)", () => {
    // The coarse path-glob intersects on the /github/repos prefix, so the
    // real PR-vs-issue narrowing is the `events` filter: an issues event is
    // not in `events` and is rejected.
    expect(
      watchRulesMatchEvent(
        rules,
        "issues.opened",
        ["/github/repos/AgentWorkforce/cloud/issues/42"],
        { action: "opened" },
      ),
    ).toBe(false);
  });
});

describe("CONFLICT_RESOLVE_WATCH_RULES", () => {
  const rules = parseWatchRules(CONFLICT_RESOLVE_WATCH_RULES);

  it("matches created PR issue comments and leaves directive parsing to dispatch", () => {
    expect(rules).toHaveLength(1);
    expect(
      watchRulesMatchEvent(
        rules,
        "issue_comment.created",
        ["/github/repos/AgentWorkforce/cloud/issues/42/comments/comment-1.json"],
        { action: "created" },
      ),
    ).toBe(true);
    expect(
      watchRulesMatchEvent(
        rules,
        "issue_comment.edited",
        ["/github/repos/AgentWorkforce/cloud/issues/42/comments/comment-1.json"],
        { action: "edited" },
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// plan resolution
// ---------------------------------------------------------------------------

function prPayload(overrides: {
  mergeable_state?: string;
  mergeable?: boolean | null;
  headRef?: string;
  baseRef?: string;
  number?: number;
  fork?: boolean;
  headSha?: string;
}): unknown {
  const baseFull = "AgentWorkforce/cloud";
  const headFull = overrides.fork ? "contributor/cloud" : baseFull;
  return {
    action: "synchronize",
    repository: { name: "cloud", full_name: baseFull, owner: { login: "AgentWorkforce" } },
    pull_request: {
      number: overrides.number ?? 42,
      mergeable: overrides.mergeable === undefined ? null : overrides.mergeable,
      mergeable_state: overrides.mergeable_state,
      head: {
        ref: overrides.headRef ?? "feature/widget",
        sha: overrides.headSha ?? "a".repeat(40),
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

const noSleep = async () => {};

describe("resolveConflictAutofixPlan", () => {
  it("produces a rebase plan for a dirty non-fork PR once mergeability settles", async () => {
    let calls = 0;
    const plan = await resolveConflictAutofixPlan({
      payload: prPayload({ mergeable_state: "unknown", mergeable: null }),
      // first read unknown (do not trust), then dirty
      fetchPullRequest: async () => {
        calls += 1;
        return calls === 1
          ? { mergeable: null, mergeable_state: "unknown" }
          : { mergeable: false, mergeable_state: "dirty", headSha: "c".repeat(40) };
      },
      delayMs: 0,
      sleep: noSleep,
    });
    expect(plan.action).toBe("rebase");
    if (plan.action !== "rebase") return;
    expect(plan.owner).toBe("AgentWorkforce");
    expect(plan.repo).toBe("cloud");
    expect(plan.number).toBe(42);
    expect(plan.baseBranch).toBe("main");
    expect(plan.headRef).toBe("feature/widget");
    // lease anchor prefers the freshest poll-observed head sha
    expect(plan.expectedHeadSha).toBe("c".repeat(40));
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("skips (not-conflicting) when the PR settles clean — the loop terminator", async () => {
    const plan = await resolveConflictAutofixPlan({
      payload: prPayload({ mergeable_state: "dirty", mergeable: false }),
      fetchPullRequest: async () => ({ mergeable: true, mergeable_state: "clean" }),
      delayMs: 0,
      sleep: noSleep,
    });
    expect(plan.action).toBe("skip");
    if (plan.action !== "skip") return;
    expect(plan.reason).toBe("not-conflicting");
  });

  it("never rebases a fork and surfaces a comment", async () => {
    let fetched = false;
    const plan = await resolveConflictAutofixPlan({
      payload: prPayload({ mergeable_state: "dirty", mergeable: false, fork: true }),
      fetchPullRequest: async () => {
        fetched = true;
        return { mergeable: false, mergeable_state: "dirty" };
      },
      delayMs: 0,
      sleep: noSleep,
    });
    expect(plan.action).toBe("skip");
    if (plan.action !== "skip") return;
    expect(plan.reason).toBe("fork");
    expect(plan.comment).toContain("fork");
    // fork is rejected from the classification before any GitHub poll
    expect(fetched).toBe(false);
  });

  it("skips (unavailable) when the PR disappears mid-poll", async () => {
    const plan = await resolveConflictAutofixPlan({
      payload: prPayload({ mergeable_state: "unknown", mergeable: null }),
      fetchPullRequest: async () => null,
      delayMs: 0,
      sleep: noSleep,
    });
    expect(plan.action).toBe("skip");
    if (plan.action !== "skip") return;
    expect(plan.reason).toBe("unavailable");
  });

  it("skips (incomplete-identity) when owner/repo carry shell metacharacters", async () => {
    const baseFull = "AgentWorkforce/cloud";
    const payload = {
      action: "synchronize",
      repository: {
        // a crafted owner that would break out of the safe-core's single-quoted echo
        name: "cloud",
        full_name: "evil'; rm -rf #/cloud",
        owner: { login: "evil'; rm -rf #" },
      },
      pull_request: {
        number: 9,
        mergeable: false,
        mergeable_state: "dirty",
        head: { ref: "feature/x", sha: "a".repeat(40), repo: { full_name: "evil'; rm -rf #/cloud" } },
        base: {
          ref: "main",
          sha: "b".repeat(40),
          repo: { full_name: "evil'; rm -rf #/cloud", name: "cloud", owner: { login: "evil'; rm -rf #" } },
        },
      },
    };
    let fetched = false;
    const plan = await resolveConflictAutofixPlan({
      payload,
      fetchPullRequest: async () => {
        fetched = true;
        return { mergeable: false, mergeable_state: "dirty" };
      },
      delayMs: 0,
      sleep: noSleep,
    });
    expect(plan.action).toBe("skip");
    if (plan.action !== "skip") return;
    expect(plan.reason).toBe("incomplete-identity");
    // rejected before any GitHub poll
    expect(fetched).toBe(false);
  });

  it("skips (incomplete-identity) when the settled head sha is malformed", async () => {
    const plan = await resolveConflictAutofixPlan({
      payload: prPayload({ mergeable_state: "dirty", mergeable: false }),
      fetchPullRequest: async () => ({
        mergeable: false,
        mergeable_state: "dirty",
        headSha: "not-a-sha-$(evil)",
      }),
      delayMs: 0,
      sleep: noSleep,
    });
    expect(plan.action).toBe("skip");
    if (plan.action !== "skip") return;
    expect(plan.reason).toBe("incomplete-identity");
  });

  it("skips (incomplete-identity) when the payload is not a PR", async () => {
    const plan = await resolveConflictAutofixPlan({
      payload: { action: "synchronize" },
      fetchPullRequest: async () => ({ mergeable: false, mergeable_state: "dirty" }),
      delayMs: 0,
      sleep: noSleep,
    });
    expect(plan.action).toBe("skip");
    if (plan.action !== "skip") return;
    expect(plan.reason).toBe("incomplete-identity");
  });
});

// ---------------------------------------------------------------------------
// invoke-script composition
// ---------------------------------------------------------------------------

const rebasePlan: Extract<ConflictAutofixPlan, { action: "rebase" }> = {
  action: "rebase",
  owner: "AgentWorkforce",
  repo: "cloud",
  number: 42,
  baseBranch: "main",
  headRef: "feature/widget",
  expectedHeadSha: "a".repeat(40),
};

describe("buildConflictAutofixInvokeScript", () => {
  it("force-pushes with --force-with-lease anchored to the detected sha, never plain --force", () => {
    const script = buildConflictAutofixInvokeScript({
      plan: rebasePlan,
      remoteUrl: "file:///tmp/remote.git",
    });
    expect(script).toContain(`--force-with-lease='feature/widget:${"a".repeat(40)}'`);
    // The push is ONLY ever --force-with-lease. `--force`/`-f` appear on
    // fetch/checkout (safe), but every `git push` line must use the lease and
    // never a bare force.
    for (const line of script.split("\n")) {
      if (/\bgit push\b/.test(line)) {
        expect(line).toContain("--force-with-lease=");
        expect(line).not.toMatch(/push\b[^\n]*\s(-f|--force)(\s|=|$)/);
      }
    }
    // Exits on the safe-core's exit code so a non-pushed outcome is non-zero.
    expect(script.trimEnd().endsWith('exit "$CONFLICT_AUTOFIX_EXIT"')).toBe(true);
  });

  it("rebases onto the base branch only (origin/main), never an arbitrary ref", () => {
    const script = buildConflictAutofixInvokeScript({
      plan: rebasePlan,
      remoteUrl: "file:///tmp/remote.git",
    });
    expect(script).toContain("refs/remotes/origin/main");
    expect(script).toContain("rebase 'refs/remotes/origin/main'");
    // base branch only — no rebase onto an arbitrary/caller ref
    expect(script).not.toMatch(/rebase '(?!refs\/remotes\/origin\/main')/);
  });

  it("appends an optional comment script before exiting", () => {
    const script = buildConflictAutofixInvokeScript({
      plan: rebasePlan,
      remoteUrl: "file:///tmp/remote.git",
      commentScript: "echo POST_COMMENT",
    });
    const commentIdx = script.indexOf("echo POST_COMMENT");
    const exitIdx = script.lastIndexOf('exit "$CONFLICT_AUTOFIX_EXIT"');
    expect(commentIdx).toBeGreaterThan(0);
    expect(exitIdx).toBeGreaterThan(commentIdx);
    // `set -u` is relaxed just before the comment script so an optional-var
    // reference there can't abort before the authoritative rebase exit.
    const relaxIdx = script.indexOf("set +u");
    expect(relaxIdx).toBeGreaterThan(0);
    expect(relaxIdx).toBeLessThan(commentIdx);
  });

  it("does not emit set +u when there is no comment script", () => {
    const script = buildConflictAutofixInvokeScript({
      plan: rebasePlan,
      remoteUrl: "file:///tmp/remote.git",
    });
    expect(script).not.toContain("set +u");
  });

  it("throws on an unsafe head ref (defence-in-depth)", () => {
    expect(() =>
      buildConflictAutofixInvokeScript({
        plan: { ...rebasePlan, headRef: "../evil" },
        remoteUrl: "file:///tmp/remote.git",
      }),
    ).toThrow();
  });
});

describe("conflictAutofixOutcomeIsSuccess", () => {
  it("treats only pushed/rebased/pending as success", () => {
    expect(conflictAutofixOutcomeIsSuccess("pushed")).toBe(true);
    expect(conflictAutofixOutcomeIsSuccess("rebased")).toBe(true);
    expect(conflictAutofixOutcomeIsSuccess("conflict")).toBe(false);
    expect(conflictAutofixOutcomeIsSuccess("head-advanced")).toBe(false);
    expect(conflictAutofixOutcomeIsSuccess("lease-rejected")).toBe(false);
    expect(conflictAutofixOutcomeIsSuccess("fetch-failed")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// end-to-end safety: run the composed script against real bare git remotes
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

function runScript(script: string, cwd: string): { status: number; out: string } {
  const res = spawnSync("bash", ["-c", script], { cwd, encoding: "utf8" });
  return { status: res.status ?? -1, out: `${res.stdout}\n${res.stderr}` };
}

describe("conflict-autofix invoke script (real git remotes)", () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /**
   * Build a bare "remote" repo with a base branch and a head branch that
   * conflicts (clean=false) or merges cleanly (clean=true) onto base.
   */
  function setupRemote(clean: boolean): {
    remote: string;
    headSha: string;
    work: string;
  } {
    root = mkdtempSync(join(tmpdir(), "s6-autofix-"));
    const remote = join(root, "remote.git");
    const seed = join(root, "seed");
    mkdirSync(remote);
    mkdirSync(seed);
    git(remote, ["init", "--bare", "-b", "main"]);
    git(seed, ["init", "-b", "main"]);
    git(seed, ["config", "user.email", "seed@example.com"]);
    git(seed, ["config", "user.name", "seed"]);
    writeFileSync(join(seed, "file.txt"), "base-line-1\nshared\n");
    git(seed, ["add", "."]);
    git(seed, ["commit", "-m", "base"]);
    git(seed, ["remote", "add", "origin", remote]);
    git(seed, ["push", "origin", "main"]);

    // head branch off the original base
    git(seed, ["checkout", "-b", "feature/widget"]);
    writeFileSync(join(seed, "file.txt"), "head-change\nshared\n");
    git(seed, ["commit", "-am", "head change"]);
    git(seed, ["push", "origin", "feature/widget"]);
    const headSha = git(seed, ["rev-parse", "HEAD"]);

    // advance base in a way that conflicts (or not) with the head change
    git(seed, ["checkout", "main"]);
    writeFileSync(
      join(seed, "file.txt"),
      clean ? "base-line-1\nshared\nbase-extra\n" : "base-conflicting\nshared\n",
    );
    git(seed, ["commit", "-am", "advance base"]);
    git(seed, ["push", "origin", "main"]);

    const work = join(root, "work");
    mkdirSync(work);
    return { remote, headSha, work };
  }

  it("rebases a cleanly-rebasable dirty PR and force-with-lease pushes", () => {
    const { remote, headSha, work } = setupRemote(true);
    const script = buildConflictAutofixInvokeScript({
      plan: { ...rebasePlan, expectedHeadSha: headSha },
      remoteUrl: `file://${remote}`,
      workspaceDir: work,
    });
    const { status, out } = runScript(script, work);
    expect(out).toContain("CONFLICT_AUTOFIX_OUTCOME=pushed");
    expect(status).toBe(CONFLICT_AUTOFIX_EXIT.OK);

    // remote head moved to the rebased commit (parent is now base tip)
    const verify = mkdtempSync(join(tmpdir(), "s6-verify-"));
    git(verify, ["clone", "-b", "feature/widget", remote, "checkout"]);
    const co = join(verify, "checkout");
    const newHead = git(co, ["rev-parse", "HEAD"]);
    expect(newHead).not.toBe(headSha);
    rmSync(verify, { recursive: true, force: true });
  });

  it("aborts on a real conflict and leaves the remote head byte-identical (no clobber)", () => {
    const { remote, headSha, work } = setupRemote(false);
    const before = git(remote, ["rev-parse", "feature/widget"]);
    expect(before).toBe(headSha);
    const script = buildConflictAutofixInvokeScript({
      plan: { ...rebasePlan, expectedHeadSha: headSha },
      remoteUrl: `file://${remote}`,
      workspaceDir: work,
    });
    const { status, out } = runScript(script, work);
    expect(out).toContain("CONFLICT_AUTOFIX_OUTCOME=conflict");
    expect(status).toBe(CONFLICT_AUTOFIX_EXIT.CONFLICT);
    // remote branch unchanged
    expect(git(remote, ["rev-parse", "feature/widget"])).toBe(headSha);
  });

  it("refuses a PR whose head advanced after detection (head-advanced, no push)", () => {
    const { remote, work } = setupRemote(true);
    // detection anchored to a stale sha (the head has since advanced)
    const staleSha = "f".repeat(40);
    const before = git(remote, ["rev-parse", "feature/widget"]);
    const script = buildConflictAutofixInvokeScript({
      plan: { ...rebasePlan, expectedHeadSha: staleSha },
      remoteUrl: `file://${remote}`,
      workspaceDir: work,
    });
    const { status, out } = runScript(script, work);
    expect(out).toContain("CONFLICT_AUTOFIX_OUTCOME=head-advanced");
    expect(status).toBe(CONFLICT_AUTOFIX_EXIT.HEAD_ADVANCED);
    // remote branch untouched
    expect(git(remote, ["rev-parse", "feature/widget"])).toBe(before);
  });
});

describe("CONFLICT_AUTOFIX_BOT_LOGIN", () => {
  it("is the safe-core bot identity (self-trigger anchor)", () => {
    expect(CONFLICT_AUTOFIX_BOT_LOGIN).toBe("relay-conflict-autofix[bot]");
  });
});

// ---------------------------------------------------------------------------
// delivery glue: git auth preamble, sandbox script composition, outcome parse
// ---------------------------------------------------------------------------

describe("buildConflictAutofixGitAuth", () => {
  it("captures the token, unsets the env var, and writes an x-access-token askpass", () => {
    const { preamble, gitCommandPrefix } = buildConflictAutofixGitAuth();
    // token captured into a shell var then the source env var is unset so it
    // does not persist in the process environment past setup.
    expect(preamble).toContain(`CONFLICT_AUTOFIX_GIT_TOKEN_VALUE="\${${CONFLICT_AUTOFIX_GIT_TOKEN_ENV}:-}"`);
    expect(preamble).toContain(`unset ${CONFLICT_AUTOFIX_GIT_TOKEN_ENV}`);
    // askpass answers GitHub's x-access-token basic-auth scheme.
    expect(preamble).toContain("x-access-token");
    expect(preamble).toContain("GIT_ASKPASS");
    // the prefix wires GIT_ASKPASS + re-exports the captured token per-command.
    expect(gitCommandPrefix).toContain("GIT_TERMINAL_PROMPT=0");
    expect(gitCommandPrefix).toContain('GIT_ASKPASS="$CONFLICT_AUTOFIX_GIT_ASKPASS"');
    expect(gitCommandPrefix).toContain('CONFLICT_AUTOFIX_GIT_TOKEN="$CONFLICT_AUTOFIX_GIT_TOKEN_VALUE"');
  });

  it("honours a custom token env key", () => {
    const { preamble } = buildConflictAutofixGitAuth("MY_TOKEN");
    expect(preamble).toContain('CONFLICT_AUTOFIX_GIT_TOKEN_VALUE="${MY_TOKEN:-}"');
    expect(preamble).toContain("unset MY_TOKEN");
  });
});

describe("buildConflictAutofixSandboxScript", () => {
  it("prepends the auth preamble and wires the askpass prefix into the rebase fetch/push", () => {
    const script = buildConflictAutofixSandboxScript({
      plan: rebasePlan,
      remoteUrl: "https://github.com/AgentWorkforce/cloud.git",
      workspaceDir: "/home/daytona/workspace",
    });
    // preamble first, then the rebase body.
    expect(script.indexOf("GIT_ASKPASS")).toBeLessThan(script.indexOf("git fetch"));
    // network ops are authenticated via the prefix; the remote URL stays plain.
    expect(script).toContain('GIT_ASKPASS="$CONFLICT_AUTOFIX_GIT_ASKPASS" CONFLICT_AUTOFIX_GIT_TOKEN="$CONFLICT_AUTOFIX_GIT_TOKEN_VALUE" git fetch');
    expect(script).toContain("git remote add origin 'https://github.com/AgentWorkforce/cloud.git'");
    expect(script).not.toContain("x-access-token@github.com");
    // exits on the rebase code (no comment script — comments post worker-side).
    expect(script.trimEnd().endsWith('exit "$CONFLICT_AUTOFIX_EXIT"')).toBe(true);
    expect(script).not.toContain("set +u");
    // never a plain force push.
    for (const line of script.split("\n")) {
      if (line.includes("git push")) {
        expect(line).toContain("--force-with-lease");
        expect(line).not.toMatch(/--force(\s|$)/);
        expect(line).not.toMatch(/\bpush\s+-f\b/);
      }
    }
  });

  it("drives a real cleanly-rebasable PR to pushed through the composed sandbox script", () => {
    const root = mkdtempSync(join(tmpdir(), "s6-sandbox-"));
    try {
      const remote = join(root, "remote.git");
      const seed = join(root, "seed");
      mkdirSync(remote);
      mkdirSync(seed);
      git(remote, ["init", "--bare", "-b", "main"]);
      git(seed, ["init", "-b", "main"]);
      git(seed, ["config", "user.email", "seed@example.com"]);
      git(seed, ["config", "user.name", "seed"]);
      writeFileSync(join(seed, "file.txt"), "base-line-1\nshared\n");
      git(seed, ["add", "."]);
      git(seed, ["commit", "-m", "base"]);
      git(seed, ["remote", "add", "origin", remote]);
      git(seed, ["push", "origin", "main"]);
      git(seed, ["checkout", "-b", "feature/widget"]);
      writeFileSync(join(seed, "file.txt"), "head-change\nshared\n");
      git(seed, ["commit", "-am", "head change"]);
      git(seed, ["push", "origin", "feature/widget"]);
      const headSha = git(seed, ["rev-parse", "HEAD"]);
      git(seed, ["checkout", "main"]);
      writeFileSync(join(seed, "file.txt"), "base-line-1\nshared\nbase-extra\n");
      git(seed, ["commit", "-am", "advance base"]);
      git(seed, ["push", "origin", "main"]);

      const work = join(root, "work");
      mkdirSync(work);
      const script = buildConflictAutofixSandboxScript({
        plan: { ...rebasePlan, expectedHeadSha: headSha },
        // file:// remote needs no auth; the askpass preamble is written but
        // never invoked, proving it is inert for unauthenticated remotes.
        remoteUrl: `file://${remote}`,
        workspaceDir: work,
      });
      const { status, out } = runScript(script, work);
      expect(out).toContain("CONFLICT_AUTOFIX_OUTCOME=pushed");
      expect(status).toBe(CONFLICT_AUTOFIX_EXIT.OK);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("parseConflictAutofixOutcome", () => {
  it("returns the last recognized outcome echoed by the rebase shell", () => {
    const output = [
      "[conflict-autofix] starting safe rebase",
      "CONFLICT_AUTOFIX_OUTCOME=pending",
      "CONFLICT_AUTOFIX_EXIT=0",
      "CONFLICT_AUTOFIX_OUTCOME=pushed",
      "CONFLICT_AUTOFIX_EXIT=0",
    ].join("\n");
    expect(parseConflictAutofixOutcome(output)).toBe("pushed");
  });

  it("recognizes hyphenated stand-down outcomes", () => {
    expect(parseConflictAutofixOutcome("CONFLICT_AUTOFIX_OUTCOME=head-advanced")).toBe("head-advanced");
    expect(parseConflictAutofixOutcome("CONFLICT_AUTOFIX_OUTCOME=lease-rejected")).toBe("lease-rejected");
    expect(parseConflictAutofixOutcome("CONFLICT_AUTOFIX_OUTCOME=conflict")).toBe("conflict");
  });

  it("returns null when no outcome line is present (script killed before emit)", () => {
    expect(parseConflictAutofixOutcome("some unrelated stderr noise")).toBeNull();
    expect(parseConflictAutofixOutcome("")).toBeNull();
    expect(parseConflictAutofixOutcome(null)).toBeNull();
    expect(parseConflictAutofixOutcome(undefined)).toBeNull();
  });

  it("ignores an unrecognized outcome token", () => {
    expect(parseConflictAutofixOutcome("CONFLICT_AUTOFIX_OUTCOME=bogus")).toBeNull();
  });
});
