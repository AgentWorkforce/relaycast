export interface CloudRepoSetupOptions {
  branch: string;
  committerName?: string;
  extraSetupCommands?: string[];
  skipWorkspaceBuild?: boolean;
}

// Adds the two deterministic steps every cloud-repo workflow needs before any
// agent touches code:
//   - setup-branch: git config + `git checkout -B <branch>`
//   - install-deps: npm install + npm run build:platform + npm run build:core
//
// Pre-building @cloud/platform + @cloud/core avoids type-resolution failures
// in fresh sandboxes that previously led agents to invent external-modules.d.ts
// shims and `as GetObjectCommandOutput` casts as workarounds.
//
// Usage:
//   const wf = applyCloudRepoSetup(
//     workflow(NAME).description('...').pattern('dag')...,
//     { branch: BRANCH, committerName: 'My Workflow Bot' },
//   );
//   wf.step('read-spec', { dependsOn: ['install-deps'], ... });
export function applyCloudRepoSetup<T>(wf: T, opts: CloudRepoSetupOptions): T {
  const committerName = opts.committerName ?? 'Cloud Repo Bot';
  const runAndTailHelper = [
    'run_and_tail() {',
    '  local log_file="$1"',
    '  local tail_lines="$2"',
    '  shift 2',
    '  set +e',
    '  "$@" > "$log_file" 2>&1',
    '  local status=$?',
    '  set -e',
    '  tail -n "$tail_lines" "$log_file"',
    '  return "$status"',
    '}',
  ].join('\n');
  const setupBranchCommand = [
    'set -e',
    'git config user.email "agent@agent-relay.com"',
    `git config user.name ${JSON.stringify(committerName)}`,
    `git checkout -B ${opts.branch}`,
    'git log -1 --oneline',
    ...(opts.extraSetupCommands ?? []),
  ].join(' && ');

  // NOTE: the step command is handed to the runner's shell directly, so a
  // plain multi-line script works. Do NOT wrap this in `bash -lc` +
  // JSON.stringify: bash double quotes keep `\n` LITERAL and the outer shell
  // expands `$1`/`$@` to empty, producing `syntax error near unexpected token
  // '('` — this exact regression killed the Phase 1 workflow run on
  // 2026-06-04 and was re-introduced once by an automated fixer (PR #1894
  // history).
  const installCommand = opts.skipWorkspaceBuild
    ? [
        'set -euo pipefail',
        'mkdir -p .logs',
        runAndTailHelper,
        'run_and_tail .logs/npm-install.log 10 npm install --legacy-peer-deps --no-audit --no-fund',
      ].join('\n')
    : [
        'set -euo pipefail',
        'mkdir -p .logs',
        runAndTailHelper,
        'run_and_tail .logs/npm-install.log 10 npm install --legacy-peer-deps --no-audit --no-fund',
        'run_and_tail .logs/build-platform.log 5 npm run build:platform',
        'run_and_tail .logs/build-core.log 5 npm run build:core',
      ].join('\n');

  interface StepChain {
    step: (name: string, cfg: unknown) => StepChain;
  }
  const chain = wf as unknown as StepChain;
  chain
    .step('setup-branch', {
      type: 'deterministic',
      command: setupBranchCommand,
      captureOutput: true,
      failOnError: true,
    })
    .step('install-deps', {
      type: 'deterministic',
      dependsOn: ['setup-branch'],
      command: installCommand,
      captureOutput: true,
      failOnError: true,
    });
  return wf;
}
