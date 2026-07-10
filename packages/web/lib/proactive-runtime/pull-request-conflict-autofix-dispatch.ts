/**
 * S6 — dispatch/persona wiring for the merge-conflict auto-fix safe core.
 *
 * PR #1510 landed {@link ../pull-request-conflict-autofix} — the deterministic,
 * safety-gated core (classify / poll / build-rebase-script / build-comment) but
 * it shipped DORMANT: nothing invoked it. This module is the follow-up wiring
 * that makes S6 end-to-end exercisable. It mirrors the S5 ci-fix plumbing
 * (#1511): a persona is matched by `watch_rules` + `conditions` on `pull_request`
 * events, and a self-trigger guard plus the #1491 PR-context cooldown stop the
 * auto-fix push from re-triggering itself.
 *
 * The conflict-autofix path is intentionally NOT an LLM persona: the safe core
 * is deterministic shell, so the persona simply runs
 * {@link buildPullRequestRebaseScript} in a sandbox and posts a
 * {@link buildConflictAutofixComment} when it cannot land a clean rebase. Every
 * safety gate from the core is preserved by construction:
 *
 *   - rebase onto the base branch only (refs validated by `isSafeGitRefName`);
 *   - push only with `--force-with-lease` anchored to the detected head SHA;
 *   - abort + comment on any conflict (never auto-resolve markers);
 *   - refuse a PR whose head advanced (pre-rebase check + lease anchor);
 *   - never touch a fork (the core's classifier fails safe to "fork");
 *   - never plain `--force`.
 *
 * Dormant-safety: the path only activates for a persona whose spec declares the
 * `conflictAutofix` capability AND whose `watch_rules` match a `pull_request`
 * event. With no such persona deployed, {@link isConflictAutofixPersona} is
 * false everywhere and the dispatcher behaves exactly as before — identical to
 * how the pr-reviewer and S5 ci-fix personas stay dark until deployed.
 */

import {
  CONFLICT_AUTOFIX_EXIT,
  buildConflictAutofixComment,
  buildPullRequestRebaseScript,
  classifyPullRequestMergeState,
  isSafeGitRefName,
  pollPullRequestMergeableState,
  type ConflictAutofixOutcome,
  type PullRequestRebaseConfig,
  // NB: this relative sibling import is intentionally EXTENSIONLESS. A `.js`
  // specifier for this `.ts` source (the original #1532 form) resolves under
  // tsc (`moduleResolution: bundler`) and CI Turbopack, but FAILS the
  // OpenNext-CF deploy build's secondary esbuild pass over the bundled
  // server-functions ("Can't resolve './pull-request-conflict-autofix.js'") —
  // which broke every prod deploy and forced the #1533 revert. Extensionless
  // matches the proactive-runtime/ relative-sibling convention (e.g.
  // `./persona-deploy`); only cross-package `@cloud/core/*` imports keep `.js`
  // because that package ships built `.js` artifacts.
} from "./pull-request-conflict-autofix";
export {
  isConflictAutofixPersona,
} from "@cloud/core/proactive-runtime/capabilities.js";
export { isConflictResolvePersona } from "./conflict-resolve-capability";
import type { WatchRule } from "@cloud/core/proactive-runtime/match.js";

/**
 * `owner` and `repo` are interpolated into the safe-core's status `echo`
 * (single-quoted, but the safe core does NOT validate these two fields the way
 * it validates refs/sha). A crafted webhook with `owner: "'; evil #"` could
 * break out of the quote, so we reject anything outside GitHub's own
 * owner/repo character set before a plan is produced. Defence-in-depth on top
 * of the core's quoting; matches GitHub's `[A-Za-z0-9._-]` slug rules.
 */
const SAFE_OWNER_REPO = /^[A-Za-z0-9._-]+$/u;
const SAFE_HEAD_SHA = /^[0-9a-fA-F]{7,64}$/u;

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Capability detection (dormant gate)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Watch rules + self-trigger identity
// ---------------------------------------------------------------------------

/**
 * The PR webhook actions worth (re)checking mergeability on. `opened` and
 * `reopened` cover a PR that lands already-conflicting; `synchronize` covers a
 * head push; `edited` covers a base-branch retarget; `ready_for_review` covers
 * a draft becoming reviewable. A base-branch push that makes open PRs dirty
 * surfaces to each PR as a fresh classification when GitHub recomputes
 * mergeability — the poll handles the async settle.
 */
export const CONFLICT_AUTOFIX_PR_ACTIONS = [
  "opened",
  "reopened",
  "synchronize",
  "edited",
  "ready_for_review",
] as const;

/**
 * Canonical `watch_rules` for a conflict-autofix persona. Matches `pull_request`
 * events on any repo's PR path; the `conditions` narrow to the actions above so
 * unrelated PR sub-events (e.g. `labeled`, `assigned`) never wake the persona.
 * Final mergeability is still confirmed by polling at dispatch time — the
 * webhook's `mergeable_state` is frequently `unknown` immediately after a push.
 */
export const CONFLICT_AUTOFIX_WATCH_RULES: WatchRule[] = [
  {
    paths: ["/github/repos/**/pulls/**"],
    events: ["pull_request.opened", "pull_request.reopened", "pull_request.synchronize", "pull_request.edited", "pull_request.ready_for_review"],
    conditions: [{ field: "action", in: [...CONFLICT_AUTOFIX_PR_ACTIONS] }],
  },
];

/**
 * The bot identity whose `pull_request.synchronize` pushes are the
 * conflict-autofix persona's own writebacks. The safe rebase pushes to the PR
 * head, which emits a `synchronize` — without suppressing the bot's own push,
 * a successful auto-fix would immediately re-trigger another classification.
 * The #1491 PR-context cooldown is the second line of defence; this is the
 * first (and the natural loop terminator, since a cleanly rebased PR reports
 * `mergeable_state: clean` and is filtered by the classifier).
 */
export const CONFLICT_AUTOFIX_BOT_LOGIN = "relay-conflict-autofix[bot]";

export const CONFLICT_RESOLVE_WATCH_RULES: WatchRule[] = [
  {
    paths: ["/github/repos/**/issues/**", "/github/repos/**/pulls/**"],
    events: ["issue_comment.created"],
    conditions: [{ field: "action", in: ["created"] }],
  },
];

const CONFLICT_RESOLVE_DIRECTIVE_RE = /(?:^|\s)@relay\s+(?:fix|resolve)\s+conflicts(?:\s|$)/iu;

export function matchesConflictResolveDirective(body: unknown): boolean {
  return typeof body === "string" && CONFLICT_RESOLVE_DIRECTIVE_RE.test(body);
}

// ---------------------------------------------------------------------------
// Plan resolution
// ---------------------------------------------------------------------------

export type ConflictAutofixSkipReason =
  | "not-a-pull-request"
  | "incomplete-identity"
  | "fork"
  | "not-conflicting"
  | "unavailable";

export type ConflictAutofixPlan =
  | {
      action: "rebase";
      owner: string;
      repo: string;
      number: number;
      baseBranch: string;
      headRef: string;
      expectedHeadSha: string;
    }
  | {
      action: "skip";
      reason: ConflictAutofixSkipReason;
      /** Present when the skip warrants a human-facing PR comment (fork). */
      comment: string | null;
    };

export type ResolveConflictAutofixPlanInput = {
  /** The dispatched event payload (the flattened `pull_request` record). */
  payload: unknown;
  /**
   * Re-reads the PR's mergeability from GitHub. The webhook payload's
   * `mergeable_state` is frequently `unknown`, so we poll until it settles.
   * Return `null` if the PR is gone.
   */
  fetchPullRequest: (attempt: number) => Promise<{
    mergeable?: boolean | null;
    mergeable_state?: string | null;
    headSha?: string | null;
  } | null>;
  maxAttempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Decide what the conflict-autofix persona should do for a `pull_request`
 * event. This is the bridge between the dispatched payload and the safe core:
 * it classifies the webhook, polls GitHub to confirm the conflict has settled,
 * and only then produces a `rebase` plan with the head SHA observed at
 * detection (the `--force-with-lease` anchor).
 *
 * Crucially, the poll's settled head SHA REPLACES the webhook head SHA as the
 * lease anchor: between the webhook and the poll the branch may have advanced,
 * and anchoring to the freshest observed SHA keeps the head-advanced gate tight
 * while still refusing to clobber a concurrent push at execution time.
 */
export async function resolveConflictAutofixPlan(
  input: ResolveConflictAutofixPlanInput,
): Promise<ConflictAutofixPlan> {
  const classification = classifyPullRequestMergeState(input.payload);

  if (
    classification.number === null ||
    classification.owner === null ||
    classification.repo === null ||
    !SAFE_OWNER_REPO.test(classification.owner) ||
    !SAFE_OWNER_REPO.test(classification.repo)
  ) {
    return { action: "skip", reason: "incomplete-identity", comment: null };
  }

  if (classification.fromFork) {
    // We can never push to a fork head. Surface a comment so a human knows the
    // bot deliberately stood down rather than silently doing nothing.
    return {
      action: "skip",
      reason: "fork",
      comment: buildForkSkipComment(classification.number, classification.baseRef, classification.headRef),
    };
  }

  if (!isSafeGitRefName(classification.headRef) || !isSafeGitRefName(classification.baseRef)) {
    return { action: "skip", reason: "incomplete-identity", comment: null };
  }

  // The webhook's mergeable_state is unreliable immediately after a push, so
  // poll until GitHub settles it before committing to (or skipping) a rebase.
  const settled = await pollPullRequestMergeableState({
    fetchPullRequest: input.fetchPullRequest,
    maxAttempts: input.maxAttempts,
    delayMs: input.delayMs,
    sleep: input.sleep,
  });

  if (settled.state === "unavailable") {
    return { action: "skip", reason: "unavailable", comment: null };
  }

  if (settled.state !== "dirty") {
    // `clean`/`blocked`/`behind`/`unstable`/... are not real base conflicts we
    // auto-rebase. A cleanly-rebased PR reports `clean` here, which is what
    // breaks the auto-fix → synchronize → re-fire loop.
    return { action: "skip", reason: "not-conflicting", comment: null };
  }

  // Prefer the freshest head SHA observed by the poll; fall back to the webhook
  // SHA. The classifier already guaranteed a non-null webhook head SHA for a
  // dirty non-fork PR, so a definite anchor always exists.
  // The rebase shell strictly validates the anchor SHA and THROWS on a
  // malformed one; validate here so a malformed/malicious sha skips gracefully
  // instead of rejecting the delivery with an exception.
  const expectedHeadSha = asString(settled.headSha) ?? classification.headSha;
  if (!expectedHeadSha || !SAFE_HEAD_SHA.test(expectedHeadSha)) {
    return { action: "skip", reason: "incomplete-identity", comment: null };
  }

  return {
    action: "rebase",
    owner: classification.owner,
    repo: classification.repo,
    number: classification.number,
    baseBranch: classification.baseRef as string,
    headRef: classification.headRef as string,
    expectedHeadSha,
  };
}

function buildForkSkipComment(
  number: number,
  baseRef: string | null,
  headRef: string | null,
): string {
  const sentinel = "<!-- relay-conflict-autofix -->";
  const head = headRef ?? "the PR branch";
  const base = baseRef ?? "the base branch";
  return (
    `${sentinel}\n` +
    `ℹ️ **Automatic conflict resolution skipped — this PR is from a fork.**\n\n` +
    `\`${head}\` lives on a fork, so the bot cannot push a rebase onto ` +
    `\`${base}\`. Please rebase and resolve the conflicts from the fork ` +
    `manually.`
  );
}

// ---------------------------------------------------------------------------
// Invoke-script composition
// ---------------------------------------------------------------------------

/** Outcome → PR comment author note for the autofix run (mirrors core comments). */
export { buildConflictAutofixComment };

export type BuildConflictAutofixInvokeScriptInput = {
  plan: Extract<ConflictAutofixPlan, { action: "rebase" }>;
  /** Remote URL for `origin` (tokenized https in prod, `file://` in tests). */
  remoteUrl: string;
  workspaceDir?: string;
  /** Env prefix for authenticated network git ops (askpass). Empty in tests. */
  gitCommandPrefix?: string;
  /**
   * Shell that posts a PR comment given `$CONFLICT_AUTOFIX_OUTCOME`. Receives
   * the outcome variable already set by the rebase script. Omitted in unit
   * tests that only assert on the rebase shell.
   */
  commentScript?: string | null;
};

/**
 * Compose the full sandbox invoke script for one conflict-autofix run.
 *
 * Mirrors the exit-precedence discipline of `buildDeploymentInvokeScript`: the
 * safe rebase script sets `CONFLICT_AUTOFIX_OUTCOME` / `CONFLICT_AUTOFIX_EXIT`
 * (it is built with `exitAtEnd: false`), then an optional comment script runs,
 * and finally the script exits with the rebase exit code so the delivery layer
 * sees a non-zero exit for every non-`pushed` outcome (conflict / head-advanced
 * / lease-rejected / fetch-failed) — exactly the signals that must NOT be
 * recorded as a successful deployment.
 */
export function buildConflictAutofixInvokeScript(
  input: BuildConflictAutofixInvokeScriptInput,
): string {
  const rebaseConfig: PullRequestRebaseConfig = {
    owner: input.plan.owner,
    repo: input.plan.repo,
    number: input.plan.number,
    baseBranch: input.plan.baseBranch,
    headRef: input.plan.headRef,
    expectedHeadSha: input.plan.expectedHeadSha,
    remoteUrl: input.remoteUrl,
    workspaceDir: input.workspaceDir,
    gitCommandPrefix: input.gitCommandPrefix,
    // Leave the exit/outcome vars set for the composed script's own precedence.
    exitAtEnd: false,
  };
  // Throws on unsafe refs/sha — defence-in-depth; resolveConflictAutofixPlan
  // already applied isSafeGitRefName, so a throw here is a programming error.
  const rebaseScript = buildPullRequestRebaseScript(rebaseConfig);

  const lines = [
    "set -u",
    rebaseScript,
  ];

  if (input.commentScript && input.commentScript.trim()) {
    // Post the comment for any non-pushed outcome BEFORE we exit on the rebase
    // code. The comment script is expected to no-op when the outcome is
    // `pushed`/`rebased` (the happy path needs no comment).
    //
    // Relax `set -u` only for the comment script: the deterministic rebase
    // script is written to be nounset-safe, but a comment helper may reference
    // optional env vars (e.g. `$GH_TOKEN`) without `${VAR:-}` defaults, and an
    // unbound-variable abort there must not prevent us from exiting on the
    // authoritative rebase exit code.
    lines.push("set +u");
    lines.push(input.commentScript);
  }

  lines.push('exit "$CONFLICT_AUTOFIX_EXIT"');
  return lines.join("\n");
}

/**
 * Map a rebase outcome to whether the delivery should be treated as a clean
 * success. Only `pushed` (and the transient `rebased`/`pending` states, which
 * the shell never exits on) are success; every safety stand-down is a
 * non-success the delivery layer surfaces.
 */
export function conflictAutofixOutcomeIsSuccess(outcome: ConflictAutofixOutcome): boolean {
  return outcome === "pushed" || outcome === "rebased" || outcome === "pending";
}

export { CONFLICT_AUTOFIX_EXIT };

// ---------------------------------------------------------------------------
// Sandbox delivery glue (consumed by deployment-trigger-delivery.ts)
// ---------------------------------------------------------------------------

/**
 * Env var the delivery layer uses to hand the minted GitHub installation token
 * to the sandbox. Captured into a shell var and `unset` by the auth preamble so
 * the token never persists in the process environment past the askpass setup.
 */
export const CONFLICT_AUTOFIX_GIT_TOKEN_ENV = "CONFLICT_AUTOFIX_GIT_TOKEN";

/**
 * Git auth preamble + network command prefix for the rebase script, mirroring
 * the pr-reviewer askpass pattern (`githubTokenCaptureLines`/`withGitTokenPrefix`
 * in deployment-trigger-delivery.ts):
 *
 *   - the installation token arrives in `tokenEnvKey` (set via the runScript
 *     `env`, never interpolated into the script text);
 *   - the preamble captures it into a shell var, `unset`s the env var, and
 *     writes a `GIT_ASKPASS` helper that answers `x-access-token:<token>`;
 *   - the returned `gitCommandPrefix` is fed to {@link buildPullRequestRebaseScript}
 *     so ONLY `git fetch`/`git push` are authenticated and the token is never
 *     written into the `origin` remote URL (the rebase script adds a PLAIN
 *     `https://github.com/...` remote, matching the pr-reviewer guard that
 *     refuses a tokenized persisted remote).
 */
export function buildConflictAutofixGitAuth(
  tokenEnvKey: string = CONFLICT_AUTOFIX_GIT_TOKEN_ENV,
): { preamble: string; gitCommandPrefix: string } {
  const askpassPath = "/tmp/conflict-autofix-git-askpass.sh";
  const preamble = [
    `CONFLICT_AUTOFIX_GIT_TOKEN_VALUE="\${${tokenEnvKey}:-}"`,
    `unset ${tokenEnvKey}`,
    `CONFLICT_AUTOFIX_GIT_ASKPASS=${askpassPath}`,
    `cat > "$CONFLICT_AUTOFIX_GIT_ASKPASS" <<'ASKPASS'`,
    "#!/usr/bin/env sh",
    'case "$1" in',
    "*Username*) printf '%s\\n' 'x-access-token' ;;",
    '*) printf \'%s\\n\' "$CONFLICT_AUTOFIX_GIT_TOKEN" ;;',
    "esac",
    "ASKPASS",
    'chmod 700 "$CONFLICT_AUTOFIX_GIT_ASKPASS"',
  ].join("\n");
  // The captured value is re-exported under CONFLICT_AUTOFIX_GIT_TOKEN only for
  // the duration of each git invocation, scoped on the same line as the git
  // command so it never leaks into the wider shell environment.
  const gitCommandPrefix =
    'GIT_TERMINAL_PROMPT=0 GIT_ASKPASS="$CONFLICT_AUTOFIX_GIT_ASKPASS" ' +
    'CONFLICT_AUTOFIX_GIT_TOKEN="$CONFLICT_AUTOFIX_GIT_TOKEN_VALUE"';
  return { preamble, gitCommandPrefix };
}

/**
 * Compose the complete sandbox script for a conflict-autofix rebase run: the
 * git-auth preamble followed by {@link buildConflictAutofixInvokeScript}. The
 * outcome PR comment is NOT posted from the sandbox — the delivery layer parses
 * the echoed `CONFLICT_AUTOFIX_OUTCOME` from the run output and posts via the
 * GitHub proxy (`createGithubProxyIssueComment`), so the comment never depends
 * on the sandbox having proxy credentials or a relayfile mount.
 */
export function buildConflictAutofixSandboxScript(input: {
  plan: Extract<ConflictAutofixPlan, { action: "rebase" }>;
  /** Plain (non-tokenized) https remote; auth flows via the askpass prefix. */
  remoteUrl: string;
  workspaceDir?: string;
  tokenEnvKey?: string;
}): string {
  const auth = buildConflictAutofixGitAuth(input.tokenEnvKey);
  const invoke = buildConflictAutofixInvokeScript({
    plan: input.plan,
    remoteUrl: input.remoteUrl,
    workspaceDir: input.workspaceDir,
    gitCommandPrefix: auth.gitCommandPrefix,
    commentScript: null,
  });
  return `${auth.preamble}\n${invoke}`;
}

const CONFLICT_AUTOFIX_OUTCOME_VALUES: readonly ConflictAutofixOutcome[] = [
  "pending",
  "rebased",
  "pushed",
  "conflict",
  "head-advanced",
  "lease-rejected",
  "fetch-failed",
];

/**
 * Recover the authoritative {@link ConflictAutofixOutcome} from a finished run's
 * stdout. The rebase shell echoes `CONFLICT_AUTOFIX_OUTCOME=<x>` (potentially
 * more than once as it progresses); the LAST recognized value wins, since the
 * shell only ever advances the outcome forward. Returns `null` when no outcome
 * line is present (e.g. the script was killed before it emitted one), which the
 * delivery layer treats as a non-success it must surface rather than silently
 * marking the run clean.
 */
export function parseConflictAutofixOutcome(
  output: string | null | undefined,
): ConflictAutofixOutcome | null {
  if (!output) return null;
  const matches = [...output.matchAll(/CONFLICT_AUTOFIX_OUTCOME=([A-Za-z-]+)/g)];
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const value = matches[i]?.[1];
    if (value && (CONFLICT_AUTOFIX_OUTCOME_VALUES as readonly string[]).includes(value)) {
      return value as ConflictAutofixOutcome;
    }
  }
  return null;
}
