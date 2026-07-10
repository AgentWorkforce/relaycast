// Shared worktree setup for cf-runtime workflows.
//
// Per user memory `feedback_always_worktree_for_prs`: every PR must be built
// in an isolated worktree so unrelated dirty files in the caller's checkout
// are never picked up.
//
// Adds two deterministic steps:
//   - preflight: fail if required binaries are missing or repo path is wrong
//   - setup-worktree: create a fresh worktree off origin/main at a known path
//   - install-deps: npm install inside the worktree (+ optional workspace builds)
//
// Subsequent workflow steps must `cd` into the worktree path. The helper
// exposes the path via a step output so downstream steps can consume it with
// `{{steps.setup-worktree.output}}` — that output is the absolute path, one
// line, nothing else.

export interface WorktreeSetupOptions {
  // Human-readable name of the repo this workflow operates against, e.g.
  // 'agent-assistant' or 'cloud'. Used only for logging.
  repoLabel: string;

  // Absolute path to the repo we're branching from. The workflow `.run({ cwd })`
  // is the cloud repo (where these workflow files live), so every step that
  // runs git needs an explicit path.
  repoPath: string;

  // Feature branch name, e.g. 'feat/cf-runtime-core'
  branch: string;

  // Base branch we branch from. Default: 'main'.
  base?: string;

  // Absolute path where the worktree will live. Default:
  //   <repoPath>/../.cf-runtime-worktrees/<sanitized-branch>
  worktreePath?: string;

  // Extra install / build commands to run after `npm install`. Each entry is
  // executed with `cd "$WT" && <cmd>` so they all run inside the worktree.
  extraSetupCommands?: string[];

  // Skip `npm install` entirely (rare — only for workflows that don't touch
  // runnable code).
  skipInstall?: boolean;

  // Committer name/email to set inside the worktree. Default:
  //   name: 'CF Runtime Workflow Bot'
  //   email: 'agent@agent-relay.com'
  committerName?: string;
  committerEmail?: string;

  // Kept for API compatibility with callers that pass it, but unused.
  // Worktrees are always fresh so a dirty-file allow-list is unnecessary.
  expectedDirty?: string[];
}

// We want the same shape as applyCloudRepoSetup in ../lib/cloud-repo-setup.ts
// so the builder can be threaded through a chain of .step() calls.
interface StepChain {
  step: (name: string, cfg: unknown) => StepChain;
}

export function applyWorktreeSetup<T>(wf: T, opts: WorktreeSetupOptions): T {
  const base = opts.base ?? 'main';
  const sanitizedBranch = opts.branch.replace(/[^a-zA-Z0-9._-]/g, '-');
  const worktreePath =
    opts.worktreePath ??
    `${opts.repoPath}/../.cf-runtime-worktrees/${sanitizedBranch}`;
  const committerName = opts.committerName ?? 'CF Runtime Workflow Bot';
  const committerEmail = opts.committerEmail ?? 'agent@agent-relay.com';

  // Preflight: just confirm the target repo path is a git repo. Binary/auth
  // checks are deferred to the step that actually needs them (gh auth runs at
  // PR-open time). Keeping this minimal makes resumes quick.
  const preflightCommand = [
    `test -d ${JSON.stringify(opts.repoPath)} || (echo "ERROR: repo path missing: ${opts.repoPath}"; exit 1)`,
    `test -e ${JSON.stringify(opts.repoPath + '/.git')} || (echo "ERROR: not a git repo: ${opts.repoPath}"; exit 1)`,
    'echo PREFLIGHT_OK',
  ].join(' && ');

  // Worktree setup is idempotent: if a worktree already lives at WT (from a
  // prior run), remove it and recreate off origin/base.
  const setupWorktreeCommand = [
    'set -e',
    `REPO=${JSON.stringify(opts.repoPath)}`,
    `WT=${JSON.stringify(worktreePath)}`,
    `BRANCH=${JSON.stringify(opts.branch)}`,
    `BASE=${JSON.stringify(base)}`,
    'mkdir -p "$(dirname "$WT")"',
    'cd "$REPO"',
    'git fetch origin "$BASE" --quiet',
    'if git worktree list --porcelain | grep -q "worktree $WT"; then git worktree remove --force "$WT" >/dev/null 2>&1 || true; fi',
    'rm -rf "$WT"',
    'if git show-ref --verify --quiet "refs/heads/$BRANCH"; then git branch -f "$BRANCH" "origin/$BASE"; fi',
    'git worktree add -B "$BRANCH" "$WT" "origin/$BASE"',
    'cd "$WT"',
    `git config user.email ${JSON.stringify(committerEmail)}`,
    `git config user.name ${JSON.stringify(committerName)}`,
    'echo "$WT"',
  ].join(' && ');

  // Install deps inside the worktree.
  const installCommand = opts.skipInstall
    ? `echo ${JSON.stringify(worktreePath)}`
    : [
        'set -e',
        `WT=${JSON.stringify(worktreePath)}`,
        'cd "$WT"',
        'npm install --legacy-peer-deps --no-audit --no-fund 2>&1 | tail -10',
        ...(opts.extraSetupCommands ?? []).map((c) => `(${c})`),
        'echo "$WT"',
      ].join(' && ');

  const chain = wf as unknown as StepChain;
  chain
    .step('preflight', {
      type: 'deterministic',
      command: preflightCommand,
      captureOutput: true,
      failOnError: true,
    })
    .step('setup-worktree', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: setupWorktreeCommand,
      captureOutput: true,
      failOnError: true,
    })
    .step('install-deps', {
      type: 'deterministic',
      dependsOn: ['setup-worktree'],
      command: installCommand,
      captureOutput: true,
      failOnError: true,
    });

  return wf;
}

// Helper for downstream steps: prefix any shell command with `cd` into the
// worktree so commands run against the isolated checkout. Use this in any
// command string in the workflow after install-deps.
export function inWorktree(worktreePath: string, command: string): string {
  return `cd ${JSON.stringify(worktreePath)} && ${command}`;
}

// Common final step: push the branch and open a PR. The caller supplies the
// PR title and body (as a string, not a path — this helper writes it to a
// temp file internally so there's no heredoc-inside-join footgun). Returns
// the step config; the caller chains it in.
export interface PushAndOpenPrOptions {
  worktreePath: string;
  branch: string;
  baseBranch?: string;
  repoSlug: string;          // e.g. 'AgentWorkforce/cloud'
  title: string;
  bodyLines: string[];
  dependsOn: string[];
  labels?: string[];
}

export function pushAndOpenPrStep(opts: PushAndOpenPrOptions) {
  const base = opts.baseBranch ?? 'main';
  // Labels are best-effort: missing labels in the target repo cause `gh pr create`
  // to fail. Create them first (idempotent) so the PR open never silently breaks.
  const ensureLabelCmds = (opts.labels ?? []).map(
    (l) =>
      `gh label create ${JSON.stringify(l)} --repo ${JSON.stringify(opts.repoSlug)} --color BFD4F2 >/dev/null 2>&1 || true`,
  );
  const labelArgs = (opts.labels ?? []).map((l) => `--label ${JSON.stringify(l)}`).join(' ');
  const bodyPrintfArgs = opts.bodyLines.map((l) => JSON.stringify(l)).join(' ');
  // pipefail makes pipeline failures visible to set -e (otherwise `gh ... | tee`
  // masks gh's exit code and the PR step "succeeds" without opening a PR).
  const prUrlFile = `/tmp/pr-url-${opts.branch.replace(/[^a-zA-Z0-9]/g, '-')}.txt`;
  const command = [
    'set -eo pipefail',
    `WT=${JSON.stringify(opts.worktreePath)}`,
    'cd "$WT"',
    `git push -u origin ${JSON.stringify(opts.branch)}`,
    ...ensureLabelCmds,
    'BODY=$(mktemp)',
    `printf "%s\\n" ${bodyPrintfArgs} > "$BODY"`,
    `gh pr create --repo ${JSON.stringify(opts.repoSlug)} --base ${JSON.stringify(base)} --head ${JSON.stringify(opts.branch)} --title ${JSON.stringify(opts.title)} --body-file "$BODY" ${labelArgs} | tee ${prUrlFile}`,
    'rm -f "$BODY"',
    `echo "PR opened:"; cat ${prUrlFile}`,
  ].join(' && ');

  return {
    type: 'deterministic' as const,
    dependsOn: opts.dependsOn,
    command,
    captureOutput: true,
    failOnError: true,
  };
}
