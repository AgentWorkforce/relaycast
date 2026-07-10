// Cloud Web Migration — Hyperdrive Option B (PrivateLink-equivalent via CF Tunnel)
// ──────────────────────────────────────────────────────────────────────────────
// Wave: Phase 3 prerequisite. Worktree: cloud-hyperdrive-tunnel.
//
// Goal: Stand up the Cloudflare Tunnel + Access + Hyperdrive infrastructure
// so the Phase 3 web Worker can reach Aurora WITHOUT exposing Aurora to the
// public internet. All declarative via @pulumi/cloudflare; no operator
// dashboard clicks (CF API token must have Tunnel/Access/Hyperdrive scopes —
// operator already did that one-time setup).
//
// What lands:
//   - infra/cloudflared-tunnel.ts   — CF Tunnel + Access app + service token
//   - infra/aurora-tunnel-daemon.ts — cloudflared Fargate task in our VPC
//   - infra/hyperdrive.ts           — replace `null` placeholder with real
//                                     cloudflare.HyperdriveConfig pointing at
//                                     the tunnel + service-token-authenticated
//   - infra/webhook-worker.ts       — revert #632's defer; re-add hyperdrive link
//   - package.json                  — add @pulumi/cloudflare devDep if missing
//
// Inlines setup-branch + install-deps. Single-line bash everywhere. Plain
// string concat (no template-literal traps). `.onError('fail-fast')`.
// ──────────────────────────────────────────────────────────────────────────────

import { workflow } from '@relayflows/core';
import { ClaudeModels, CodexModels } from '@agent-relay/config';

const NAME = 'migration-hyperdrive-option-b';
const BRANCH = 'feat/migration-hyperdrive-option-b';
const CHANNEL = `wf-${NAME}`;

const ALLOWED_DIRTY = [
  'package-lock\\.json',
  'package\\.json',
  'infra/cloudflared-tunnel\\.ts',
  'infra/aurora-tunnel-daemon\\.ts',
  'infra/hyperdrive\\.ts',
  'infra/webhook-worker\\.ts',
  'infra/secrets\\.ts',
  '\\.logs/.*',
  '\\.trajectories/.*',
  'workflows/migration-hyperdrive-option-b\\.ts',
  'workflows/lib/.*',
].join('|');

async function runWorkflow() {
  const wf = workflow(NAME)
    .description(
      'Phase 3 prereq: Cloudflare Tunnel + Access + Hyperdrive infra so Workers can reach private Aurora without public exposure. All declarative via @pulumi/cloudflare; no operator dashboard clicks.',
    )
    .pattern('dag')
    .channel(CHANNEL)
    .maxConcurrency(4)
    .timeout(3 * 60 * 60 * 1000)

    .agent('lead', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role: 'Pre-commit reviewer. Verifies no public Aurora exposure, no process.env secret reads (per .claude/rules/sst-secrets.md), correct Pulumi resource shapes, daemon VPC + SG ingress to Aurora.',
      retries: 1,
    })
    .agent('infra-impl', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Track A: writes infra/cloudflared-tunnel.ts (CF Tunnel + Access app + service token), infra/hyperdrive.ts (HyperdriveConfig pointing at tunnel + Access creds), and restores the hyperdrive link in infra/webhook-worker.ts.',
      retries: 2,
    })
    .agent('daemon-impl', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Track B (parallel): writes infra/aurora-tunnel-daemon.ts — sst.aws.Service running cloudflare/cloudflared in our VPC, security group allowing port 5432 to Aurora.',
      retries: 2,
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
        'git config user.name "Hyperdrive Option B Bot"',
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

    .step('install-pulumi-cloudflare', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: [
        'set -e',
        'if [ -d node_modules/@pulumi/cloudflare ]; then echo "already installed"; else npm install --save-dev @pulumi/cloudflare@6.15.0 --legacy-peer-deps --no-audit --no-fund > .logs/install-pulumi-cf.log 2>&1; fi',
        'node -e "console.log(\'@pulumi/cloudflare\', require(\'@pulumi/cloudflare/package.json\').version)"',
        'echo INSTALL_PULUMI_CF_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('preflight', {
      type: 'deterministic',
      dependsOn: ['install-pulumi-cloudflare'],
      command: [
        'set -e',
        'BRANCH_NOW=$(git rev-parse --abbrev-ref HEAD)',
        'if [ "$BRANCH_NOW" != "' + BRANCH + '" ]; then echo "ERROR: wrong branch (got $BRANCH_NOW)"; exit 1; fi',
        'ALLOWED_DIRTY="' + ALLOWED_DIRTY + '"',
        'DIRTY=$({ git diff --name-only; git ls-files --others --exclude-standard; } | sort -u | grep -vE "^(${ALLOWED_DIRTY})$" || true)',
        'if [ -n "$DIRTY" ]; then echo "ERROR: unexpected drift:"; echo "$DIRTY"; exit 1; fi',
        'test -f infra/hyperdrive.ts || (echo "ERROR: infra/hyperdrive.ts missing (should be the dormant null placeholder)"; exit 1)',
        'test -f infra/webhook-worker.ts || (echo "ERROR: infra/webhook-worker.ts missing"; exit 1)',
        'test -f infra/database.ts || (echo "ERROR: infra/database.ts missing"; exit 1)',
        'echo PREFLIGHT_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('read-aurora-config', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'cat infra/database.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-vpc-config', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'cat infra/vpc.ts 2>&1 || echo "(no infra/vpc.ts — VPC may be inline elsewhere)"',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-hyperdrive-placeholder', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'cat infra/hyperdrive.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-webhook-worker', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'cat infra/webhook-worker.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-account-config', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'cat infra/account.ts 2>&1 | head -50 && echo "---" && cat sst.config.ts 2>&1 | head -40',
      captureOutput: true,
      failOnError: true,
    })

    // ─── Track A: Tunnel + Access + Hyperdrive ───────────────────────────────
    .step('write-tunnel-and-access', {
      agent: 'infra-impl',
      dependsOn: ['read-aurora-config', 'read-account-config'],
      task: [
        'Create infra/cloudflared-tunnel.ts.',
        '',
        'Aurora config (for the tunnel target):',
        '{{steps.read-aurora-config.output}}',
        '',
        'SST account config (for accountId):',
        '{{steps.read-account-config.output}}',
        '',
        'Requirements:',
        '',
        'Import @pulumi/cloudflare. Read its README in node_modules/@pulumi/cloudflare/ first to confirm current resource names (the provider has had renames; verify ZeroTrustTunnelCloudflared, ZeroTrustTunnelCloudflaredConfig, ZeroTrustAccessApplication, ZeroTrustAccessServiceToken exist as named exports).',
        '',
        '1. Generate a 32-byte tunnel secret as a Pulumi RandomBytes resource (or via crypto.randomBytes wrapped in a pulumi.secret).',
        '',
        '2. Create the CF Tunnel:',
        '   - new cloudflare.ZeroTrustTunnelCloudflared("AuroraDbTunnel", {',
        '       accountId: <cloudflareAccountId from sst config or env>,',
        '       name: $app.stage + "-aurora-db-tunnel",',
        '       tunnelSecret: <generated secret base64>,',
        '     })',
        '',
        '3. Create the tunnel route config to expose Aurora as a TCP private network:',
        '   - new cloudflare.ZeroTrustTunnelCloudflaredConfig("AuroraDbTunnelConfig", {',
        '       accountId, tunnelId: tunnel.id,',
        '       config: {',
        '         warpRouting: { enabled: true },',
        '         originRequest: {},',
        '         ingressRules: [ { service: "tcp://<aurora-endpoint>:5432" } ],',
        '       },',
        '     })',
        '   The aurora endpoint reference must be a Pulumi Output<string> from the existing appDatabase / Aurora resource — DO NOT hardcode.',
        '',
        '4. Create the CF Access application protecting the tunnel:',
        '   - new cloudflare.ZeroTrustAccessApplication("AuroraDbAccessApp", {',
        '       accountId,',
        '       name: "aurora-db",',
        '       type: "self_hosted",',
        '       domain: <stage>-aurora-db.<your-zone>,  // or use the tunnel cfargotunnel domain',
        '       sessionDuration: "24h",',
        '     })',
        '',
        '5. Create a service token for Hyperdrive to authenticate:',
        '   - new cloudflare.ZeroTrustAccessServiceToken("AuroraDbHyperdriveToken", {',
        '       accountId,',
        '       name: "hyperdrive-aurora",',
        '     })',
        '   - Bind the service token to the Access application via cloudflare.ZeroTrustAccessPolicy with decision "non_identity" and include[{ serviceToken: { tokenId: serviceToken.id } }]',
        '',
        '6. Export everything: tunnel, tunnel.tunnelToken (Pulumi secret output — daemon consumes this), accessApplication, serviceToken, serviceToken.clientId, serviceToken.clientSecret (Pulumi secret outputs).',
        '',
        '7. Add a top-of-file comment explaining the design and referring to docs/migration/hyperdrive-network-path.md (PR #634).',
        '',
        'Rules:',
        '- Never hardcode account IDs, hostnames, or secrets — use SST Resource references or Pulumi Output<T> values.',
        '- The CF API token in CI already has Tunnel/Access/Hyperdrive scopes (operator added them).',
        '- Use @pulumi/cloudflare directly, NOT sst.cloudflare.* (which has no Hyperdrive/Tunnel components).',
        '',
        'Post TUNNEL_AND_ACCESS_DONE.',
      ].join('\n'),
      verification: { type: 'exit_code' },
    })
    .step('verify-tunnel-and-access', {
      type: 'deterministic',
      dependsOn: ['write-tunnel-and-access'],
      command: [
        'set -e',
        'test -f infra/cloudflared-tunnel.ts || (echo "FAIL: missing infra/cloudflared-tunnel.ts"; exit 1)',
        'grep -q "ZeroTrustTunnelCloudflared" infra/cloudflared-tunnel.ts || (echo "FAIL: ZeroTrustTunnelCloudflared resource missing"; exit 1)',
        'grep -q "ZeroTrustAccessApplication" infra/cloudflared-tunnel.ts || (echo "FAIL: AccessApplication missing"; exit 1)',
        'grep -q "ZeroTrustAccessServiceToken" infra/cloudflared-tunnel.ts || (echo "FAIL: AccessServiceToken missing"; exit 1)',
        // The "no process.env" and "Aurora public" checks moved to final-review (claude reviewer)
        // where semantics can be judged. Shell regex false-positives on canonical patterns
        // (infra/sage.ts, infra/traffic-recorder.ts, etc. all use process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID).
        'echo VERIFY_TUNNEL_AND_ACCESS_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('write-hyperdrive', {
      agent: 'infra-impl',
      dependsOn: ['verify-tunnel-and-access', 'read-hyperdrive-placeholder'],
      task: [
        'Replace infra/hyperdrive.ts.',
        '',
        'Current dormant placeholder:',
        '{{steps.read-hyperdrive-placeholder.output}}',
        '',
        'New shape:',
        '',
        '1. Import @pulumi/cloudflare.',
        '2. Import { tunnel, serviceToken } from "./cloudflared-tunnel".',
        '3. Import { appDatabase } from "./database" for credentials.',
        '4. Declare:',
        '   - new cloudflare.HyperdriveConfig("CloudDb", {',
        '       accountId,',
        '       name: $app.stage + "-cloud-db",',
        '       origin: {',
        '         scheme: "postgres",',
        '         host: <tunnel cfargotunnel hostname or Access-protected hostname>,',
        '         port: 5432,',
        '         database: appDatabase.database,',
        '         user: appDatabase.username,',
        '         password: appDatabase.password,',
        '         accessClientId: serviceToken.clientId,',
        '         accessClientSecret: serviceToken.clientSecret,',
        '       },',
        '     })',
        '',
        '5. Export `hyperdrive` as before (so existing import sites in webhook-worker etc. still work).',
        '',
        '6. Keep the previous design-intent comment block; expand to note that Option B (this file) replaces the prior dormant null placeholder.',
        '',
        'Rules:',
        '- Use Pulumi Output<string> chaining for the hostname — do NOT hardcode.',
        '- Read CF docs at https://developers.cloudflare.com/hyperdrive/configuration/connect-to-private-database/ if unsure about the access-protected-origin shape; this is the documented pattern as of 2024.',
        '- No process.env. Resource.X.value or Pulumi Outputs only.',
        '',
        'Post HYPERDRIVE_DONE.',
      ].join('\n'),
      verification: { type: 'exit_code' },
    })
    .step('verify-hyperdrive', {
      type: 'deterministic',
      dependsOn: ['write-hyperdrive'],
      command: [
        'set -e',
        'test -f infra/hyperdrive.ts || (echo "FAIL"; exit 1)',
        'grep -q "HyperdriveConfig" infra/hyperdrive.ts || (echo "FAIL: HyperdriveConfig resource missing"; exit 1)',
        '! grep -qE "export const hyperdrive = null" infra/hyperdrive.ts || (echo "FAIL: still the dormant placeholder"; exit 1)',
        'grep -q "accessClientId" infra/hyperdrive.ts || (echo "FAIL: missing CF Access service-token binding"; exit 1)',
        // process.env check moved to final-review — false-positive on CLOUDFLARE_DEFAULT_ACCOUNT_ID
        'echo VERIFY_HYPERDRIVE_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('restore-webhook-worker-link', {
      agent: 'infra-impl',
      dependsOn: ['verify-hyperdrive', 'read-webhook-worker'],
      task: [
        'Edit infra/webhook-worker.ts to restore the hyperdrive link that PR #632 deferred.',
        '',
        'Current contents:',
        '{{steps.read-webhook-worker.output}}',
        '',
        '1. Re-add `import { hyperdrive } from "./hyperdrive";` at the top.',
        '2. Re-add `hyperdrive` to the `link: [...]` array on the WebhookWorker Worker resource.',
        '3. In the `appendWorkerBindings` (or equivalent) call, re-add the `HYPERDRIVE` binding entry.',
        '4. Remove the `TODO(Phase 3):` markers that #632 left as breadcrumbs.',
        '',
        'Only modify infra/webhook-worker.ts. Post RESTORE_DONE.',
      ].join('\n'),
      verification: { type: 'exit_code' },
    })
    .step('verify-webhook-restore', {
      type: 'deterministic',
      dependsOn: ['restore-webhook-worker-link'],
      command: [
        'set -e',
        'grep -q "import { hyperdrive }" infra/webhook-worker.ts || (echo "FAIL: hyperdrive import missing"; exit 1)',
        'grep -q "HYPERDRIVE" infra/webhook-worker.ts || (echo "FAIL: HYPERDRIVE binding missing"; exit 1)',
        '! grep -q "TODO(Phase 3)" infra/webhook-worker.ts || (echo "FAIL: stale TODO markers should be removed"; exit 1)',
        'echo VERIFY_WEBHOOK_RESTORE_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ─── Track B (parallel): cloudflared Fargate daemon ──────────────────────
    .step('write-cloudflared-daemon', {
      agent: 'daemon-impl',
      dependsOn: ['read-vpc-config', 'read-aurora-config'],
      task: [
        'Create infra/aurora-tunnel-daemon.ts.',
        '',
        'VPC config:',
        '{{steps.read-vpc-config.output}}',
        '',
        'Aurora config (for the SG ingress rule):',
        '{{steps.read-aurora-config.output}}',
        '',
        'Requirements:',
        '',
        '1. Import the tunnel from "./cloudflared-tunnel".',
        '2. Import the VPC + cluster from "./vpc" (or wherever sst.aws.Vpc is declared).',
        '3. Declare:',
        '   - new sst.aws.Service("CloudflaredAuroraTunnel", {',
        '       cluster: <existing cluster>,',
        '       vpc: <existing VPC>,',
        '       image: "cloudflare/cloudflared:2024.10.0",  // PIN a version; never use :latest in prod',
        '       cpu: "0.25 vCPU",',
        '       memory: "0.5 GB",',
        '       scaling: { min: 1, max: 1 },  // single instance to start; HA bump as fast-follow',
        '       command: ["tunnel", "--no-autoupdate", "run", "--token", <tunnel token>],',
        '       // OR via env: environment: { TUNNEL_TOKEN: tunnel.tunnelToken }, command: ["tunnel", "run"]',
        '     })',
        '',
        '4. Add a security group rule so the daemon can reach Aurora on 5432:',
        '   - Use the AWS provider directly via new aws.ec2.SecurityGroupRule, or via the Aurora SG\'s ingress array if SST supports it. The daemon\'s SG must be allowed source. Pulumi the SG IDs from the daemon service + Aurora resource.',
        '',
        '5. Pulumi the daemon\'s endpoint outputs (DNS, etc.) IF the tunnel config needs them — usually not, since cloudflared connects OUTBOUND to CF and the tunnel doesn\'t need an inbound endpoint.',
        '',
        '6. Add CloudWatch alarm on daemon task health (ECS service running-count). One-line declaration is fine.',
        '',
        '7. Top-of-file comment explaining the design + link to docs/migration/hyperdrive-network-path.md.',
        '',
        'Rules:',
        '- Pin the cloudflared image version (NEVER :latest in prod).',
        '- min:1 max:1 to start. HA (min:2 max:2 across AZs) is a follow-up.',
        '- TUNNEL_TOKEN reaches the container as a secret env var sourced from Pulumi Output<string> — NOT as a hardcoded value.',
        '- No process.env. Pulumi Outputs only.',
        '',
        'Post DAEMON_DONE.',
      ].join('\n'),
      verification: { type: 'exit_code' },
    })
    .step('verify-cloudflared-daemon', {
      type: 'deterministic',
      dependsOn: ['write-cloudflared-daemon'],
      command: [
        'set -e',
        'test -f infra/aurora-tunnel-daemon.ts || (echo "FAIL"; exit 1)',
        'grep -q "sst.aws.Service" infra/aurora-tunnel-daemon.ts || (echo "FAIL: missing sst.aws.Service"; exit 1)',
        'grep -q "cloudflare/cloudflared" infra/aurora-tunnel-daemon.ts || (echo "FAIL: missing cloudflared image ref"; exit 1)',
        '! grep -qE "cloudflare/cloudflared:latest" infra/aurora-tunnel-daemon.ts || (echo "FAIL: pin a version, never use :latest in prod"; exit 1)',
        // process.env check moved to final-review — false-positive on CLOUDFLARE_DEFAULT_ACCOUNT_ID
        'echo VERIFY_DAEMON_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ─── SST typecheck (join point) ──────────────────────────────────────────
    .step('sst-typecheck', {
      type: 'deterministic',
      dependsOn: ['verify-webhook-restore', 'verify-cloudflared-daemon'],
      command: '(cd infra && npx tsc --noEmit) 2>&1 | tail -30 && echo SST_TYPECHECK_DONE',
      captureOutput: true,
      failOnError: false,
    })
    .step('fix-sst-typecheck', {
      agent: 'infra-impl',
      dependsOn: ['sst-typecheck'],
      task: 'Fix TypeScript errors in infra/. Output:\n{{steps.sst-typecheck.output}}\nNote: `.sst/platform/config.d.ts not found` is harmless (SST generates on `sst dev`); ignore that. Iterate on any other errors. Likely sources: @pulumi/cloudflare resource arg names that differ between provider versions.',
      verification: { type: 'exit_code' },
    })
    .step('sst-typecheck-final', {
      type: 'deterministic',
      dependsOn: ['fix-sst-typecheck'],
      command: 'bash -lc \'set -o pipefail; cd infra; npx tsc --noEmit 2>&1 | sed "/config.d.ts/d" | tail -10\' && echo SST_TYPECHECK_FINAL_OK',
      captureOutput: true,
      failOnError: true,
    })

    // ─── Final review ────────────────────────────────────────────────────────
    .step('final-review', {
      agent: 'lead',
      dependsOn: ['sst-typecheck-final'],
      task: [
        'Final review of the Hyperdrive Option B PR. Block on any of:',
        '',
        '1. Aurora made publicly accessible. Search infra/ for publiclyAccessible/publicly_accessible = true. If true anywhere, this PR is wrong — Option B keeps Aurora private.',
        '2. Any secret-valued process.env.* reads in the new infra files (tunnel, daemon, hyperdrive). The canonical non-secret CLOUDFLARE_DEFAULT_ACCOUNT_ID read is allowed when it is only threaded into Cloudflare provider accountId fields.',
        '3. cloudflared image not pinned to a version (e.g. :latest).',
        '4. Daemon Fargate task not in the same VPC as Aurora.',
        '5. SG ingress to Aurora open to anything besides the daemon\'s SG ID.',
        '6. Access service-token credentials hardcoded anywhere instead of Pulumi-chained from the ZeroTrustAccessServiceToken resource.',
        '7. HyperdriveConfig resource missing accessClientId/accessClientSecret — without those, Hyperdrive cannot authenticate through CF Access.',
        '',
        'If clean: write APPROVED (exactly) to .logs/hyperdrive-option-b-review.md.',
        'Otherwise: enumerate findings as a numbered list.',
      ].join('\n'),
      verification: { type: 'file_exists', value: '.logs/hyperdrive-option-b-review.md' },
    })
    .step('review-gate', {
      type: 'deterministic',
      dependsOn: ['final-review'],
      command: 'grep -qxF APPROVED .logs/hyperdrive-option-b-review.md || (cat .logs/hyperdrive-option-b-review.md; exit 1)',
      captureOutput: true,
      failOnError: true,
    })

    // ─── Commit + PR ─────────────────────────────────────────────────────────
    .step('commit', {
      type: 'deterministic',
      dependsOn: ['review-gate'],
      command: [
        'set -e',
        'git add infra/cloudflared-tunnel.ts infra/aurora-tunnel-daemon.ts infra/hyperdrive.ts infra/webhook-worker.ts',
        'git add package.json package-lock.json',
        'git diff --cached --stat',
        'MSG=$(mktemp)',
        'printf "%s\\n" "feat(migration): Hyperdrive Option B — Tunnel + Access + private Aurora" "" "Phase 3 prerequisite. Wires up the full Hyperdrive-via-Cloudflare-Tunnel" "infrastructure so Workers can reach Aurora WITHOUT exposing Aurora to" "the public internet." "" "All declarative — no operator dashboard clicks (CF API token already" "has Tunnel/Access/Hyperdrive scopes per operator setup)." "" "Deliverables:" "- infra/cloudflared-tunnel.ts  Tunnel + Access app + service token" "- infra/aurora-tunnel-daemon.ts cloudflared Fargate task in VPC" "- infra/hyperdrive.ts           real HyperdriveConfig (replaces null)" "- infra/webhook-worker.ts       restore hyperdrive link" "" "Spec: docs/migration/hyperdrive-network-path.md (PR #634)" "" "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>" > "$MSG"',
        'git commit -F "$MSG"',
        'rm -f "$MSG"',
        'git log -1 --oneline',
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
        'printf "%s\\n" "## Summary" "" "Phase 3 prereq. Wires up Hyperdrive Option B (PrivateLink-equivalent via CF Tunnel) so Workers can reach the existing private Aurora without making it publicly accessible." "" "All declarative through @pulumi/cloudflare. No operator dashboard clicks needed beyond the one-time CF API token scope expansion (already done)." "" "## What lands" "" "- \\`infra/cloudflared-tunnel.ts\\` — CF Tunnel + Access app + Access service token" "- \\`infra/aurora-tunnel-daemon.ts\\` — \\`cloudflared\\` Fargate task in our VPC, SG ingress to Aurora 5432" "- \\`infra/hyperdrive.ts\\` — real \\`cloudflare.HyperdriveConfig\\` (replaces null placeholder from #620/#632), authenticates to tunnel via Access service token" "- \\`infra/webhook-worker.ts\\` — restore hyperdrive link (revert #632\\x27s defer)" "" "## Security posture" "" "- Aurora stays in private VPC subnet, no public exposure" "- Tunnel daemon runs in our VPC, outbound-only to CF edge" "- Hyperdrive authenticates to the tunnel via CF Access service token (non-identity policy)" "- Aurora SG only accepts 5432 from the daemon\\x27s SG" "" "## What this does NOT do" "" "- HA on the tunnel daemon (min:1 max:1; HA bump is a fast-follow)" "- Phase 3 web Worker (separate PR — \\`feat/migration-phase3-web-worker-build\\`)" "- Cutover (Phase 4 workflow)" "" "## Test plan" "" "- [x] \\`(cd infra && npx tsc --noEmit)\\` clean" "- [ ] Post-deploy: \\`aws ecs describe-services\\` shows daemon healthy; \\`cloudflared\\` logs show tunnel registered" "- [ ] Post-deploy: Hyperdrive resource visible in CF dashboard with status \\"connected\\"" "- [ ] Post-deploy: a Worker test query via Hyperdrive returns rows from Aurora" "" "## Spec" "" "docs/migration/hyperdrive-network-path.md (PR #634) — Option B selected" "" "## Reviewers" "" "Please address coderabbit + codex + devin bot feedback." "" "🤖 Generated with [Claude Code](https://claude.com/claude-code)" > "$BODY"',
        'URL=$(gh pr create --title "feat(migration): Hyperdrive Option B — Tunnel + Access + private Aurora" --body-file "$BODY" --base main)',
        'rm -f "$BODY"',
        'echo "PR: $URL"',
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
