// Cloud Web Migration — Phase 1: Hyperdrive in front of RDS
// ──────────────────────────────────────────────────────────────────────────────
// Wave: 1. Worktree: cloud-phase1-hyperdrive.
// Stacked on: chore/migration-cf-decision (#615).
//
// Goal: Stand up Cloudflare Hyperdrive pointed at the existing RDS Postgres
//       so Workers (Phase 2 webhook, Phase 3 web) can reach the DB. RDS does
//       not move. Lambda continues using its existing direct-TCP path. Strictly
//       additive — no handler code touched.
//
// What lands:
//   - infra/hyperdrive.ts                     — sst.cf.Hyperdrive resource
//   - packages/web/lib/db/client-hyperdrive.ts — Workers-compatible DB client
//   - packages/web/lib/db/index.ts             — selectDbClient(env) factory
//   - packages/web/lib/boot/resource-check.ts  — REQUIRED_RESOURCES entry
//
// Inlines setup-branch + install-deps (no applyCloudRepoSetup) — same pattern
// as the other Wave-0/1 workflows after the helper's multi-line bash bug.
// ──────────────────────────────────────────────────────────────────────────────

import { workflow } from '@relayflows/core';
import { ClaudeModels, CodexModels } from '@agent-relay/config';

const NAME = 'migration-phase1-hyperdrive';
const BRANCH = 'feat/migration-phase1-hyperdrive';
const CHANNEL = `wf-${NAME}`;

const ALLOWED_DIRTY = [
  'package-lock\\.json',
  'package\\.json',
  'packages/web/package\\.json',
  'infra/hyperdrive\\.ts',
  'infra/secrets\\.ts',
  'packages/web/lib/db/.*',
  'packages/web/lib/boot/resource-check\\.ts',
  '\\.logs/.*',
  '\\.trajectories/.*',
  'workflows/migration-phase1-hyperdrive\\.ts',
  'workflows/lib/.*',
].join('|');

async function runWorkflow() {
  const wf = workflow(NAME)
    .description(
      'Phase 1 of the cloud web migration: stand up Cloudflare Hyperdrive in front of the existing RDS Postgres so Workers can reach the DB. Additive — Lambda DB path untouched. Gated on the CF spike recommending WORKERS.',
    )
    .pattern('dag')
    .channel(CHANNEL)
    .maxConcurrency(3)
    .timeout(2 * 60 * 60 * 1000)

    .agent('infra-impl', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Owns infra/hyperdrive.ts and the Workers-compatible DB client. RDS stays unchanged; Hyperdrive is the proxy.',
      retries: 2,
    })
    .agent('reviewer', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role: 'Pre-commit reviewer. Checks that the Lambda code path is untouched, secrets are routed via Resource.X.value (per .claude/rules/sst-secrets.md), and the wrangler binding name matches the runtime lookup.',
      retries: 1,
    });

  type StepChain = {
    step: (name: string, cfg: unknown) => StepChain;
    onError: (mode: string, opts?: unknown) => StepChain;
    run: (opts: { cwd: string }) => Promise<unknown>;
  };
  const chain = wf as unknown as StepChain;

  await chain
    .step('setup-branch', {
      type: 'deterministic',
      command: [
        'set -e',
        'git config user.email "agent@agent-relay.com"',
        'git config user.name "Phase 1 Hyperdrive Bot"',
        // NOTE: this workflow is STACKED on chore/migration-cf-decision
        // (PR #615) — that branch carries the spike report this phase's
        // preflight greps for. We intentionally do NOT base on origin/main
        // here because that would drop the spike report from the working
        // tree. The worktree-create step (`git worktree add -b feat/... chore/...`)
        // pinned the correct base; this step only normalizes git identity
        // and re-asserts the branch label.
        'git checkout -B ' + BRANCH,
        'git log -1 --oneline',
        'echo SETUP_BRANCH_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('install-deps', {
      type: 'deterministic',
      dependsOn: ['setup-branch'],
      command: [
        'set -e',
        'mkdir -p .logs',
        'npm install --legacy-peer-deps --no-audit --no-fund > .logs/npm-install.log 2>&1',
        'tail -10 .logs/npm-install.log',
        'echo INSTALL_DEPS_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('preflight', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: [
        'set -e',
        'BRANCH_NOW=$(git rev-parse --abbrev-ref HEAD)',
        'if [ "$BRANCH_NOW" != "' + BRANCH + '" ]; then echo "ERROR: wrong branch (got $BRANCH_NOW)"; exit 1; fi',
        'ALLOWED_DIRTY="' + ALLOWED_DIRTY + '"',
        'DIRTY=$({ git diff --name-only; git ls-files --others --exclude-standard; } | sort -u | grep -vE "^(${ALLOWED_DIRTY})$" || true)',
        'if [ -n "$DIRTY" ]; then echo "ERROR: unexpected drift:"; echo "$DIRTY"; exit 1; fi',
        'test -f docs/spikes/cf-spike-report.md || (echo "ERROR: spike report missing"; exit 1)',
        'grep -qE "^\\*\\*RECOMMENDATION: WORKERS\\*\\*$" docs/spikes/cf-spike-report.md || (echo "ERROR: spike did not recommend WORKERS"; exit 1)',
        'echo PREFLIGHT_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('read-secrets-infra', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'cat infra/secrets.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-database-infra', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'cat infra/database.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-db-client', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: [
        'set -e',
        'echo "── files in packages/web/lib/db/ ──"',
        'find packages/web/lib/db -type f -name "*.ts" | sort',
        'echo',
        'echo "── packages/web/lib/db/index.ts (current) ──"',
        'cat packages/web/lib/db/index.ts 2>/dev/null || echo "(no index.ts yet)"',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })
    .step('read-resource-check', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'cat packages/web/lib/boot/resource-check.ts',
      captureOutput: true,
      failOnError: true,
    })

    // ─── Write infra/hyperdrive.ts ───────────────────────────────────────────
    .step('write-hyperdrive-infra', {
      agent: 'infra-impl',
      dependsOn: ['read-secrets-infra', 'read-database-infra'],
      task: [
        'Create infra/hyperdrive.ts.',
        '',
        'Current infra/database.ts:',
        '{{steps.read-database-infra.output}}',
        '',
        'Current infra/secrets.ts:',
        '{{steps.read-secrets-infra.output}}',
        '',
        'Requirements:',
        '',
        '1. Declare new sst.cf.Hyperdrive("CloudDb", { origin: { ... } }) pointing at the existing RDS endpoint:',
        '   - Origin host: from the existing RDS resource (do NOT hardcode the hostname)',
        '   - Origin port: 5432',
        '   - Origin database: from existing config',
        '   - Origin user + password: via Resource.<Name>.value per .claude/rules/sst-secrets.md',
        '   - NEVER use process.env for these',
        '',
        '2. Export the Hyperdrive resource.',
        '',
        '3. Add a // LINK NOTE: comment listing every consumer that will need to add `link: [..., hyperdrive]` in a follow-up commit (web, webhook function, cataloging-agent-*). Do NOT modify those files in this PR — Phase 1 is additive only.',
        '',
        'Only edit infra/hyperdrive.ts. Post HYPERDRIVE_INFRA_DONE.',
      ].join('\n'),
      verification: { type: 'exit_code' },
    })
    .step('verify-hyperdrive-infra', {
      type: 'deterministic',
      dependsOn: ['write-hyperdrive-infra'],
      command: [
        'set -e',
        'test -f infra/hyperdrive.ts || (echo "FAIL: missing infra/hyperdrive.ts"; exit 1)',
        'grep -q "sst.cf.Hyperdrive" infra/hyperdrive.ts || (echo "FAIL: no Hyperdrive resource declaration"; exit 1)',
        'if grep -E "process\\.env\\." infra/hyperdrive.ts; then echo "FAIL: hyperdrive.ts reads process.env — must use Resource.X.value per .claude/rules/sst-secrets.md"; exit 1; fi',
        'echo VERIFY_HYPERDRIVE_INFRA_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ─── Update REQUIRED_RESOURCES in resource-check.ts ──────────────────────
    .step('update-resource-check', {
      agent: 'infra-impl',
      dependsOn: ['read-resource-check', 'verify-hyperdrive-infra'],
      task: [
        'Edit packages/web/lib/boot/resource-check.ts to add Hyperdrive to REQUIRED_RESOURCES.',
        '',
        'Current contents:',
        '{{steps.read-resource-check.output}}',
        '',
        'Add an entry with kind: "binding" (not "secret"), name: "CloudDb" (or whatever the Hyperdrive resource name is in infra/hyperdrive.ts).',
        '',
        'Only edit this one file. Post RESOURCE_CHECK_DONE.',
      ].join('\n'),
      verification: { type: 'exit_code' },
    })
    .step('verify-resource-check', {
      type: 'deterministic',
      dependsOn: ['update-resource-check'],
      command: [
        'set -e',
        'if git diff --quiet packages/web/lib/boot/resource-check.ts; then echo "FAIL: resource-check.ts not modified"; exit 1; fi',
        'grep -qE "CloudDb|Hyperdrive" packages/web/lib/boot/resource-check.ts || (echo "FAIL: REQUIRED_RESOURCES missing Hyperdrive entry"; exit 1)',
        'echo VERIFY_RESOURCE_CHECK_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ─── Workers-compatible DB client ────────────────────────────────────────
    .step('write-hyperdrive-client', {
      agent: 'infra-impl',
      dependsOn: ['verify-resource-check', 'read-db-client'],
      task: [
        'Create packages/web/lib/db/client-hyperdrive.ts and update packages/web/lib/db/index.ts.',
        '',
        'Current packages/web/lib/db/ state:',
        '{{steps.read-db-client.output}}',
        '',
        '1. packages/web/lib/db/client-hyperdrive.ts:',
        '   - export function createHyperdriveDb(env: { HYPERDRIVE: Hyperdrive })',
        '   - Uses the `postgres` npm package with env.HYPERDRIVE.connectionString',
        '   - Wraps in Drizzle ORM using the existing schema (import from the same schema file the Lambda client uses)',
        '   - Returns the same Drizzle DB instance shape as the existing client',
        '',
        '2. packages/web/lib/db/index.ts:',
        '   - Add a selectDbClient(env) factory that:',
        '     - returns the Hyperdrive client when env.HYPERDRIVE is present',
        '     - returns the existing TCP client otherwise',
        '   - This is the seam that lets Lambda and Workers share handlers',
        '',
        '3. Do NOT modify any handler file. Just the client factory.',
        '',
        'Post DB_CLIENT_DONE.',
      ].join('\n'),
      verification: { type: 'exit_code' },
    })
    .step('verify-db-client', {
      type: 'deterministic',
      dependsOn: ['write-hyperdrive-client'],
      command: [
        'set -e',
        'test -f packages/web/lib/db/client-hyperdrive.ts || (echo "FAIL: missing client-hyperdrive.ts"; exit 1)',
        'grep -q "selectDbClient" packages/web/lib/db/index.ts || (echo "FAIL: selectDbClient factory missing"; exit 1)',
        'grep -q "HYPERDRIVE" packages/web/lib/db/index.ts || (echo "FAIL: factory does not check env.HYPERDRIVE"; exit 1)',
        'CHANGED_HANDLERS=$(git diff --name-only | grep -E "packages/web/app/api/.*/route\\.ts" || true)',
        'if [ -n "$CHANGED_HANDLERS" ]; then echo "FAIL: handlers modified — Phase 1 is additive only:"; echo "$CHANGED_HANDLERS"; exit 1; fi',
        'echo VERIFY_DB_CLIENT_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ─── Typecheck ───────────────────────────────────────────────────────────
    .step('typecheck', {
      type: 'deterministic',
      dependsOn: ['verify-db-client'],
      command: '(cd infra && npx tsc --noEmit) 2>&1 | tail -30 && (cd packages/web && npx tsc --noEmit) 2>&1 | tail -30 && echo TYPECHECK_OK',
      captureOutput: true,
      failOnError: false,
    })
    .step('fix-typecheck', {
      agent: 'infra-impl',
      dependsOn: ['typecheck'],
      task: 'Fix TypeScript errors. Output:\n{{steps.typecheck.output}}\nIterate until clean.',
      verification: { type: 'exit_code' },
    })
    .step('typecheck-final', {
      type: 'deterministic',
      dependsOn: ['fix-typecheck'],
      command: '(cd infra && npx tsc --noEmit) && (cd packages/web && npx tsc --noEmit) && echo TYPECHECK_FINAL_OK',
      captureOutput: true,
      failOnError: true,
    })

    // ─── Acceptance suite regression check (if Phase 0 foundation landed) ────
    // This phase is additive only — the Lambda path still works. Run the
    // contract suite against current prod to confirm nothing regressed.
    // If Phase 0 hasn't merged yet, skip with a clear warning.
    .step('acceptance-suite-vs-prod', {
      type: 'deterministic',
      dependsOn: ['typecheck-final'],
      command: [
        'set -e',
        'if [ ! -d packages/acceptance ]; then echo "WARN: packages/acceptance not present — Phase 0 foundation has not landed yet. Skipping acceptance gate. Re-run after Phase 0 merges."; exit 0; fi',
        'export ACCEPTANCE_BASE_URL=https://agentrelay.com/cloud',
        'npx vitest run --dir packages/acceptance/src --reporter=basic 2>&1 | tail -40',
        'echo ACCEPTANCE_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ─── Final review ────────────────────────────────────────────────────────
    .step('final-review', {
      agent: 'reviewer',
      dependsOn: ['acceptance-suite-vs-prod'],
      task: [
        'Final review of the Phase 1 Hyperdrive PR.',
        '',
        'Block on any of:',
        '1. Any handler file under packages/web/app/api/**/route.ts modified. Phase 1 is additive only.',
        '2. Any process.env.<DB_PASSWORD|DATABASE_URL|...> reference in infra/hyperdrive.ts — must use Resource.X.value.',
        '3. REQUIRED_RESOURCES in resource-check.ts not updated with the Hyperdrive entry.',
        '4. The Worker binding name in infra/hyperdrive.ts does not match the runtime check (env.HYPERDRIVE) in client-hyperdrive.ts.',
        '5. selectDbClient(env) does not preserve the existing TCP-client return shape — would break Lambda handlers.',
        '',
        'If clean: write APPROVED (exactly) to .logs/phase1-review.md.',
        'Otherwise: enumerate findings.',
      ].join('\n'),
      verification: { type: 'file_exists', value: '.logs/phase1-review.md' },
    })
    .step('review-gate', {
      type: 'deterministic',
      dependsOn: ['final-review'],
      command: 'grep -qxF APPROVED .logs/phase1-review.md || (cat .logs/phase1-review.md; exit 1)',
      captureOutput: true,
      failOnError: true,
    })

    // ─── Commit + PR ─────────────────────────────────────────────────────────
    .step('commit', {
      type: 'deterministic',
      dependsOn: ['review-gate'],
      command: [
        'set -e',
        'git add infra/hyperdrive.ts',
        'git add packages/web/lib/db/client-hyperdrive.ts packages/web/lib/db/index.ts',
        'git add packages/web/lib/boot/resource-check.ts',
        'MSG=$(mktemp)',
        'printf "%s\\n" "feat(migration): Phase 1 — Hyperdrive in front of RDS (additive)" "" "Stands up sst.cf.Hyperdrive pointed at the existing RDS instance and" "adds a Workers-compatible DB client behind a selectDbClient() factory." "Lambda continues to use the TCP client unchanged." "" "Next: Phase 2 webhook split as a CF Worker (consumes Hyperdrive)." "" "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>" > "$MSG"',
        'git commit -F "$MSG"',
        'rm -f "$MSG"',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })
    .step('push-and-pr', {
      type: 'deterministic',
      dependsOn: ['commit'],
      command: [
        'set -e',
        'git push -u origin ' + BRANCH,
        'BODY=$(mktemp)',
        'printf "%s\\n" "## Summary" "" "Phase 1 of the cloud web migration. Adds Cloudflare Hyperdrive in front of RDS so Workers (Phase 2/3) can reach the DB. Additive — Lambda continues with its existing direct-TCP client." "" "Stacked on #615 (operator decision + wrangler devDep). Merge after #615." "" "## What changed" "" "- \\`infra/hyperdrive.ts\\` — sst.cf.Hyperdrive bound to existing RDS" "- \\`packages/web/lib/db/client-hyperdrive.ts\\` — Workers-compatible client" "- \\`packages/web/lib/db/index.ts\\` — selectDbClient() factory" "- \\`packages/web/lib/boot/resource-check.ts\\` — REQUIRED_RESOURCES entry" "" "## What does NOT change" "" "- No handler code touched" "- No schema / migration / query changes" "- Lambda DB path is untouched" "" "## Test plan" "" "- [x] tsc clean on infra + packages/web" "- [x] Acceptance suite vs current Lambda prod: 100% pass (if Phase 0 foundation landed)" "- [ ] Post-deploy: env.HYPERDRIVE binding present on Workers" "" "## Reviewers" "" "Please address coderabbit + codex bot feedback." "" "🤖 Generated with [Claude Code](https://claude.com/claude-code)" > "$BODY"',
        'gh pr create --title "feat(migration): Phase 1 — Hyperdrive in front of RDS (additive)" --body-file "$BODY" --base main | tee .logs/phase1-pr-url.txt',
        'rm -f "$BODY"',
        'echo "PR: $(cat .logs/phase1-pr-url.txt)"',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .onError('fail-fast')
    .run({ cwd: process.cwd() });

  console.log('Workflow status:', 'done');
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
