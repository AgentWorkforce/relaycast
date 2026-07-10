/**
 * S6 — automatic merge-conflict resolver for GitHub pull requests.
 *
 * When a PR becomes `mergeable_state: "dirty"` (a real merge conflict against
 * its base branch), this module powers a persona that rebases the PR head onto
 * its base branch and force-pushes the result — but ONLY behind a set of hard
 * safety gates, because an unguarded auto-rebase can silently clobber a
 * contributor's branch:
 *
 *   1. Rebase onto the PR's **base branch only**. The rebase target is the
 *      fetched `origin/<baseBranch>` ref, never an arbitrary or caller-supplied
 *      ref. Both branch names are validated against `isSafeGitRefName` before
 *      they reach the shell.
 *   2. Push with **`--force-with-lease`** anchored to the head SHA observed when
 *      the conflict was detected — never a plain `git push --force`/`-f`. If the
 *      remote head moved, the lease rejects the push instead of overwriting it.
 *   3. **Abort on any conflict.** We never auto-resolve conflict markers — a
 *      failed rebase is `git rebase --abort`ed, nothing is pushed, and the
 *      outcome is surfaced as a PR comment so a human can resolve it.
 *   4. **Never touch a PR whose head advanced during the operation.** Before
 *      rebasing we re-fetch and compare the live remote head to the expected
 *      SHA; if it changed we bail out (`head-advanced`) before any write. The
 *      `--force-with-lease` anchor enforces the same invariant atomically at
 *      push time, closing the TOCTOU window.
 *
 * Detection is split from execution so it can be unit-tested in isolation, and
 * because GitHub's `mergeable_state` is computed asynchronously: the first read
 * after a push is frequently `unknown`. {@link pollPullRequestMergeableState}
 * re-reads until the state settles instead of trusting the first value.
 */

/** GitHub `mergeable_state` values we care about, plus our own sentinels. */
export type PullRequestMergeState =
  | "clean"
  | "dirty"
  | "unknown"
  | "blocked"
  | "behind"
  | "unstable"
  | "has_hooks"
  | "draft"
  | "unavailable";

/** Exit codes emitted by the rebase shell, also used to label outcomes. */
export const CONFLICT_AUTOFIX_EXIT = {
  OK: 0,
  /** Remote head advanced past the expected SHA before we could rebase. */
  HEAD_ADVANCED: 93,
  /** Rebase hit conflicts; aborted without pushing. */
  CONFLICT: 94,
  /** `--force-with-lease` rejected the push (remote moved at push time). */
  LEASE_REJECTED: 95,
  /** A network git operation (fetch/push) failed for another reason. */
  FETCH_FAILED: 96,
} as const;

/** Machine-readable outcome echoed by the rebase shell as `CONFLICT_AUTOFIX_OUTCOME=<x>`. */
export type ConflictAutofixOutcome =
  | "pending"
  | "rebased"
  | "pushed"
  | "conflict"
  | "head-advanced"
  | "lease-rejected"
  | "fetch-failed";

export type PullRequestIdentity = {
  owner: string | null;
  repo: string | null;
  number: number | null;
  headRef: string | null;
  headSha: string | null;
  baseRef: string | null;
  baseSha: string | null;
  /** True when the head repo differs from the base repo (a fork PR). */
  fromFork: boolean;
  action: string | null;
};

export type PullRequestMergeClassification = PullRequestIdentity & {
  state: PullRequestMergeState;
  mergeable: boolean | null;
  /**
   * True only when the PR is a real conflict against its base (`dirty`) that
   * we can act on: it must have a number, a head ref, a head SHA, and not be a
   * fork (we cannot push to a fork head).
   */
  needsConflictAutofix: boolean;
  /**
   * True when GitHub has not finished computing mergeability yet, so the caller
   * should poll rather than trust this read.
   */
  needsPoll: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

/**
 * Validate a git branch / ref name before it is interpolated into a shell
 * command. Mirrors the conservative allowlist used elsewhere in the proactive
 * runtime: no leading/trailing slash, no `..`, no `@{`, no control or glob
 * characters. Rejecting unsafe refs is a defence-in-depth gate — every ref is
 * also single-quoted in the emitted shell.
 */
export function isSafeGitRefName(value: string | null | undefined): value is string {
  if (!value || value.startsWith("/") || value.endsWith("/") || value.includes("//")) return false;
  if (value.includes("..") || value.includes("@{") || value.endsWith(".lock")) return false;
  if (value.startsWith("-")) return false;
  if (value.split("/").some((segment) => !segment || segment.startsWith(".") || segment.endsWith("."))) {
    return false;
  }
  return /^[A-Za-z0-9._/-]+$/.test(value);
}

/**
 * Pull the PR identity fields we need out of a GitHub `pull_request` webhook
 * payload (or an equivalent REST PR object wrapped as `{ pull_request }`).
 */
export function pullRequestIdentityFromPayload(payload: unknown): PullRequestIdentity {
  const root = asRecord(payload) ?? {};
  const pr = asRecord(root.pull_request) ?? asRecord(root) ?? {};
  const head = asRecord(pr.head) ?? {};
  const base = asRecord(pr.base) ?? {};
  const headRepo = asRecord(head.repo);
  const baseRepo = asRecord(base.repo) ?? asRecord(root.repository);

  const baseRepoFullName = asString(baseRepo?.full_name);
  const headRepoFullName = asString(headRepo?.full_name);
  // Conservative: if we cannot positively confirm the head and base repos are
  // the same, treat the PR as a fork. Misclassifying a same-repo PR as a fork
  // merely skips the autofix; misclassifying a fork as same-repo could push to
  // the wrong repository — so the unknown case must fail safe to "fork".
  const fromFork =
    baseRepoFullName === null ||
    headRepoFullName === null ||
    baseRepoFullName !== headRepoFullName;

  const owner =
    asString(asRecord(baseRepo?.owner)?.login) ??
    (baseRepoFullName ? baseRepoFullName.split("/")[0] ?? null : null);
  const repo =
    asString(baseRepo?.name) ??
    (baseRepoFullName ? baseRepoFullName.split("/")[1] ?? null : null);

  return {
    owner,
    repo,
    number: asNumber(pr.number),
    headRef: asString(head.ref),
    headSha: asString(head.sha),
    baseRef: asString(base.ref),
    baseSha: asString(base.sha),
    fromFork,
    action: asString(root.action),
  };
}

/** Normalize a raw `mergeable_state` string into our union, defaulting to `unknown`. */
function normalizeMergeState(raw: string | null, mergeable: boolean | null): PullRequestMergeState {
  switch (raw) {
    case "clean":
    case "dirty":
    case "blocked":
    case "behind":
    case "unstable":
    case "has_hooks":
    case "draft":
    case "unknown":
      return raw;
    default:
      // No usable `mergeable_state`: fall back to the boolean if present.
      if (mergeable === false) return "dirty";
      if (mergeable === true) return "clean";
      return "unknown";
  }
}

/**
 * Classify a PR's mergeability from a webhook payload or REST PR object.
 *
 * `needsConflictAutofix` is intentionally narrow: it is true only for a `dirty`
 * (genuine conflict) non-fork PR that carries the identity fields the rebase
 * shell requires. `behind` (head merely out of date, no conflict) is NOT
 * auto-fixed here — that is a separate, lower-risk "update branch" concern.
 */
export function classifyPullRequestMergeState(payload: unknown): PullRequestMergeClassification {
  const identity = pullRequestIdentityFromPayload(payload);
  const root = asRecord(payload) ?? {};
  const pr = asRecord(root.pull_request) ?? asRecord(root) ?? {};

  const mergeable =
    typeof pr.mergeable === "boolean" ? (pr.mergeable as boolean) : null;
  const state = normalizeMergeState(asString(pr.mergeable_state), mergeable);

  const needsPoll = state === "unknown" || mergeable === null;
  const needsConflictAutofix =
    state === "dirty" &&
    !identity.fromFork &&
    identity.owner !== null &&
    identity.repo !== null &&
    identity.number !== null &&
    isSafeGitRefName(identity.headRef) &&
    isSafeGitRefName(identity.baseRef) &&
    identity.headSha !== null;

  return { ...identity, state, mergeable, needsConflictAutofix, needsPoll };
}

export type MergeableProbe = {
  mergeable?: boolean | null;
  mergeable_state?: string | null;
  /** Latest head SHA, used to refresh the lease anchor as the poll progresses. */
  headSha?: string | null;
};

export type PollMergeableStateInput = {
  /** Fetches the current PR mergeability. Return `null` if the PR is gone. */
  fetchPullRequest: (attempt: number) => Promise<MergeableProbe | null>;
  /** Max reads before giving up. Default 6. */
  maxAttempts?: number;
  /** Delay between reads in ms. Default 1500. */
  delayMs?: number;
  /** Injectable sleep for tests. Default a real `setTimeout` promise. */
  sleep?: (ms: number) => Promise<void>;
};

export type PollMergeableStateResult = {
  state: PullRequestMergeState;
  mergeable: boolean | null;
  headSha: string | null;
  attempts: number;
  /** True if mergeability resolved to a definite state before attempts ran out. */
  settled: boolean;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll GitHub for a PR's mergeability until it settles to a definite state.
 *
 * GitHub computes `mergeable`/`mergeable_state` asynchronously, so the value
 * immediately after a webhook is frequently `unknown` / `mergeable: null`. This
 * deliberately does NOT trust the first read: it keeps reading (up to
 * `maxAttempts`) while the state is `unknown` or `mergeable` is `null`, sleeping
 * `delayMs` between reads. A PR that disappears (fetch returns `null`) ends the
 * poll as `unavailable`.
 */
export async function pollPullRequestMergeableState(
  input: PollMergeableStateInput,
): Promise<PollMergeableStateResult> {
  const maxAttempts = Math.max(1, input.maxAttempts ?? 6);
  const delayMs = Math.max(0, input.delayMs ?? 1500);
  const sleep = input.sleep ?? defaultSleep;

  let lastState: PullRequestMergeState = "unknown";
  let lastMergeable: boolean | null = null;
  let lastHeadSha: string | null = null;
  let attempts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    const probe = await input.fetchPullRequest(attempt);
    if (probe === null) {
      return {
        state: "unavailable",
        mergeable: null,
        headSha: lastHeadSha,
        attempts,
        settled: true,
      };
    }
    const mergeable = typeof probe.mergeable === "boolean" ? probe.mergeable : null;
    const state = normalizeMergeState(probe.mergeable_state ?? null, mergeable);
    lastState = state;
    lastMergeable = mergeable;
    lastHeadSha = asString(probe.headSha) ?? lastHeadSha;

    const resolved = state !== "unknown" && mergeable !== null;
    if (resolved) {
      return { state, mergeable, headSha: lastHeadSha, attempts, settled: true };
    }
    if (attempt < maxAttempts) {
      await sleep(delayMs);
    }
  }

  return {
    state: lastState,
    mergeable: lastMergeable,
    headSha: lastHeadSha,
    attempts,
    settled: false,
  };
}

export type PullRequestRebaseConfig = {
  owner: string;
  repo: string;
  number: number;
  /** The PR's base branch — the rebase target. */
  baseBranch: string;
  /** The PR head branch we will update. */
  headRef: string;
  /**
   * The remote head SHA observed when the conflict was detected. Used both for
   * the pre-rebase "did the head move?" check and as the `--force-with-lease`
   * anchor at push time.
   */
  expectedHeadSha: string;
  /** Remote URL for `origin` (tokenized https in prod, `file://` in tests). */
  remoteUrl: string;
  /** Workspace directory. Defaults to the deployment workspace dir. */
  workspaceDir?: string;
  /**
   * Env prefix for network git operations (auth askpass). Empty by default so
   * the script is runnable against an unauthenticated local remote in tests.
   */
  gitCommandPrefix?: string;
  botName?: string;
  botEmail?: string;
  /**
   * When true, the script ends with `exit "$CONFLICT_AUTOFIX_EXIT"` so it can be
   * run standalone. When false (the wiring default), it leaves
   * `CONFLICT_AUTOFIX_OUTCOME` / `CONFLICT_AUTOFIX_EXIT` set for the caller to
   * apply its own exit precedence (mirrors how the push-back script sets
   * `PUSH_EXIT`).
   */
  exitAtEnd?: boolean;
};

const DEFAULT_WORKSPACE_DIR = "/home/daytona/workspace";
const DEFAULT_BOT_NAME = "relay-conflict-autofix[bot]";
const DEFAULT_BOT_EMAIL = "conflict-autofix@agent-relay.com";

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Build the safe rebase-and-force-with-lease shell for a dirty PR.
 *
 * Throws if `headRef` or `baseBranch` is not a safe git ref name — the caller
 * is expected to have classified the PR via {@link classifyPullRequestMergeState}
 * (which applies the same gate), so a throw here means a programming error, not
 * untrusted input slipping through.
 *
 * The emitted shell sets two variables the caller can inspect:
 *   - `CONFLICT_AUTOFIX_OUTCOME` — one of {@link ConflictAutofixOutcome}
 *   - `CONFLICT_AUTOFIX_EXIT`    — a {@link CONFLICT_AUTOFIX_EXIT} code
 */
export function buildPullRequestRebaseScript(config: PullRequestRebaseConfig): string {
  if (!isSafeGitRefName(config.headRef)) {
    throw new Error(`unsafe PR head ref for rebase: ${JSON.stringify(config.headRef)}`);
  }
  if (!isSafeGitRefName(config.baseBranch)) {
    throw new Error(`unsafe PR base branch for rebase: ${JSON.stringify(config.baseBranch)}`);
  }
  if (!/^[0-9a-fA-F]{7,64}$/.test(config.expectedHeadSha)) {
    throw new Error(`unsafe expected head sha for rebase: ${JSON.stringify(config.expectedHeadSha)}`);
  }

  const ws = config.workspaceDir ?? DEFAULT_WORKSPACE_DIR;
  const net = config.gitCommandPrefix ? `${config.gitCommandPrefix} ` : "";
  const botName = config.botName ?? DEFAULT_BOT_NAME;
  const botEmail = config.botEmail ?? DEFAULT_BOT_EMAIL;
  const head = config.headRef;
  const base = config.baseBranch;
  const remoteHeadRef = `refs/remotes/origin/${head}`;
  const remoteBaseRef = `refs/remotes/origin/${base}`;
  const headFetchSpec = shellSingleQuote(`+refs/heads/${head}:${remoteHeadRef}`);
  const baseFetchSpec = shellSingleQuote(`+refs/heads/${base}:${remoteBaseRef}`);
  // `--force-with-lease=<ref>:<expect>` only updates the remote ref when it is
  // still exactly `<expect>`; otherwise the push is rejected, so a head that
  // advanced after detection can never be clobbered.
  const lease = `--force-with-lease=${shellSingleQuote(`${head}:${config.expectedHeadSha}`)}`;
  const pushSpec = shellSingleQuote(`pr-autofix:refs/heads/${head}`);

  const lines = [
    `echo '[conflict-autofix] starting safe rebase for #${config.number} (${config.owner}/${config.repo})'`,
    `mkdir -p ${shellSingleQuote(ws)}`,
    `cd ${shellSingleQuote(ws)}`,
    "if [ ! -d .git ]; then git init -q; fi",
    `git config user.name ${shellSingleQuote(botName)}`,
    `git config user.email ${shellSingleQuote(botEmail)}`,
    `git remote add origin ${shellSingleQuote(config.remoteUrl)} 2>/dev/null || git remote set-url origin ${shellSingleQuote(config.remoteUrl)}`,
    "CONFLICT_AUTOFIX_OUTCOME=pending",
    `CONFLICT_AUTOFIX_EXIT=${CONFLICT_AUTOFIX_EXIT.OK}`,
    "CONFLICT_AUTOFIX_PUSHED_SHA=",
    `EXPECTED_REMOTE_HEAD=${shellSingleQuote(config.expectedHeadSha)}`,
    "",
    "# 1. Fetch the base branch (the rebase target) and the PR head — base only.",
    `if ! ${net}git fetch --no-tags --force origin ${baseFetchSpec}; then`,
    "  echo '[conflict-autofix] failed to fetch base branch' >&2",
    "  CONFLICT_AUTOFIX_OUTCOME=fetch-failed",
    `  CONFLICT_AUTOFIX_EXIT=${CONFLICT_AUTOFIX_EXIT.FETCH_FAILED}`,
    "fi",
    'if [ "$CONFLICT_AUTOFIX_OUTCOME" = pending ]; then',
    `  if ! ${net}git fetch --no-tags --force origin ${headFetchSpec}; then`,
    "    echo '[conflict-autofix] failed to fetch PR head' >&2",
    "    CONFLICT_AUTOFIX_OUTCOME=fetch-failed",
    `    CONFLICT_AUTOFIX_EXIT=${CONFLICT_AUTOFIX_EXIT.FETCH_FAILED}`,
    "  fi",
    "fi",
    "",
    "# 2. Refuse to touch a PR whose head advanced since conflict detection.",
    'if [ "$CONFLICT_AUTOFIX_OUTCOME" = pending ]; then',
    `  REMOTE_HEAD_BEFORE=$(git rev-parse ${shellSingleQuote(remoteHeadRef)} 2>/dev/null || true)`,
    '  if [ "$REMOTE_HEAD_BEFORE" != "$EXPECTED_REMOTE_HEAD" ]; then',
    `    echo "[conflict-autofix] PR head advanced (expected $EXPECTED_REMOTE_HEAD, found \${REMOTE_HEAD_BEFORE:-missing}); aborting" >&2`,
    "    CONFLICT_AUTOFIX_OUTCOME=head-advanced",
    `    CONFLICT_AUTOFIX_EXIT=${CONFLICT_AUTOFIX_EXIT.HEAD_ADVANCED}`,
    "  fi",
    "fi",
    "",
    "# 3. Check out the PR head and rebase onto the base branch ONLY.",
    'if [ "$CONFLICT_AUTOFIX_OUTCOME" = pending ]; then',
    // Gate the rebase on a successful checkout: if checkout fails we must NOT
    // rebase whatever branch happens to be current and then push it as the PR
    // head.
    `  if git checkout --force -B pr-autofix ${shellSingleQuote(remoteHeadRef)}; then`,
    `    if git -c rebase.autoStash=false rebase ${shellSingleQuote(remoteBaseRef)}; then`,
    "      CONFLICT_AUTOFIX_OUTCOME=rebased",
    "    else",
    "      echo '[conflict-autofix] rebase hit conflicts; aborting without pushing' >&2",
    "      git rebase --abort 2>/dev/null || true",
    "      CONFLICT_AUTOFIX_OUTCOME=conflict",
    `      CONFLICT_AUTOFIX_EXIT=${CONFLICT_AUTOFIX_EXIT.CONFLICT}`,
    "    fi",
    "  else",
    "    echo '[conflict-autofix] failed to check out PR head' >&2",
    "    CONFLICT_AUTOFIX_OUTCOME=fetch-failed",
    `    CONFLICT_AUTOFIX_EXIT=${CONFLICT_AUTOFIX_EXIT.FETCH_FAILED}`,
    "  fi",
    "fi",
    "",
    "# 4. Push the rebased head with --force-with-lease (never a plain --force).",
    'if [ "$CONFLICT_AUTOFIX_OUTCOME" = rebased ]; then',
    `  if ${net}git push ${lease} origin ${pushSpec}; then`,
    "    CONFLICT_AUTOFIX_OUTCOME=pushed",
    "    CONFLICT_AUTOFIX_PUSHED_SHA=$(git rev-parse HEAD 2>/dev/null || true)",
    `    echo "[conflict-autofix] rebased and pushed #${config.number} (\$CONFLICT_AUTOFIX_PUSHED_SHA)"`,
    "  else",
    "    echo '[conflict-autofix] force-with-lease push rejected; remote head moved' >&2",
    "    CONFLICT_AUTOFIX_OUTCOME=lease-rejected",
    `    CONFLICT_AUTOFIX_EXIT=${CONFLICT_AUTOFIX_EXIT.LEASE_REJECTED}`,
    "  fi",
    "fi",
    "",
    'echo "CONFLICT_AUTOFIX_OUTCOME=$CONFLICT_AUTOFIX_OUTCOME"',
    'echo "CONFLICT_AUTOFIX_EXIT=$CONFLICT_AUTOFIX_EXIT"',
  ];

  if (config.exitAtEnd) {
    lines.push('exit "$CONFLICT_AUTOFIX_EXIT"');
  }

  return lines.join("\n");
}

/**
 * Build the PR comment body posted when the autofix could not safely land a
 * rebase, so a human knows what happened and what to do. `pushed` returns null
 * (the rebase succeeded — no comment needed for the happy path).
 */
export function buildConflictAutofixComment(input: {
  outcome: ConflictAutofixOutcome;
  number: number;
  baseBranch: string;
  headRef: string;
}): string | null {
  const { outcome, baseBranch, headRef } = input;
  const sentinel = "<!-- relay-conflict-autofix -->";
  switch (outcome) {
    case "pushed":
    case "rebased":
    case "pending":
      return null;
    case "conflict":
      return (
        `${sentinel}\n` +
        `⚠️ **Automatic conflict resolution couldn't rebase this PR.**\n\n` +
        `Rebasing \`${headRef}\` onto \`${baseBranch}\` hit merge conflicts. ` +
        `To stay safe, no changes were pushed — please rebase and resolve the ` +
        `conflicts manually:\n\n` +
        "```bash\n" +
        `git fetch origin ${baseBranch}\n` +
        `git rebase origin/${baseBranch}\n` +
        "# resolve conflicts, then:\n" +
        `git push --force-with-lease\n` +
        "```"
      );
    case "head-advanced":
      return (
        `${sentinel}\n` +
        `ℹ️ **Automatic conflict resolution skipped — the branch moved.**\n\n` +
        `\`${headRef}\` advanced while a rebase onto \`${baseBranch}\` was being ` +
        `prepared, so nothing was pushed (to avoid overwriting the newer commits). ` +
        `The rebase will be retried automatically the next time the PR is reported ` +
        `as conflicting.`
      );
    case "lease-rejected":
      return (
        `${sentinel}\n` +
        `ℹ️ **Automatic conflict resolution skipped — the branch moved during push.**\n\n` +
        `A \`--force-with-lease\` push of the rebased \`${headRef}\` was rejected ` +
        `because the remote branch changed concurrently. No commits were ` +
        `overwritten; the rebase will be retried automatically.`
      );
    case "fetch-failed":
      return (
        `${sentinel}\n` +
        `⚠️ **Automatic conflict resolution couldn't reach the repository.**\n\n` +
        `Fetching \`${baseBranch}\`/\`${headRef}\` failed, so no rebase was ` +
        `attempted. This will be retried automatically.`
      );
    default:
      return null;
  }
}
