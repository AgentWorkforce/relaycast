/**
 * cloud-iac-sst.ts
 *
 * Adds Cloudflare IaC to the existing SST project at ../cloud for relayfile
 * and relayauth. Relaycast is skipped — its resources already exist in CF
 * and will be imported into SST state later.
 *
 * This workflow also moves worker code into cloud/packages/:
 *   - ../relayfile-cloud/src/  → cloud/packages/relayfile/  (wrangler + worker)
 *   - ../relayauth/packages/server/  → cloud/packages/relayauth/  (wrangler + worker)
 *
 * After this, relayfile-cloud can be archived. relayauth/packages/server
 * becomes a thin pointer or gets removed.
 *
 * Target structure:
 *   cloud/
 *     packages/
 *       relayfile/             ← worker code + wrangler.toml (from relayfile-cloud)
 *       relayauth/             ← worker code + wrangler.toml (from relayauth/packages/server)
 *       cli/                   (existing)
 *       core/                  (existing)
 *       router/                (existing)
 *       web/                   (existing)
 *     infra/
 *       cloudflare/            ← NEW
 *         index.ts             ← composes relayfile + relayauth (not relaycast)
 *         relayfile.ts         ← D1, KV, R2, Queues, DNS
 *         relayauth.ts         ← D1, KV, DNS
 *     sst.config.ts            ← UPDATED: imports cloudflare module
 *     infra/secrets.ts         ← UPDATED: adds CF secrets
 *
 * Run: agent-relay run workflows/cloud-iac-sst.ts
 */

const { workflow } = require('@agent-relay/sdk/workflows');

const CLOUD = process.env.CLOUD_PATH || '/Users/khaliqgant/Projects/AgentWorkforce/cloud';
const RELAYFILE_CLOUD = process.env.RELAYFILE_CLOUD_PATH || '/Users/khaliqgant/Projects/AgentWorkforce/relayfile-cloud';
const RELAYAUTH = process.env.RELAYAUTH_PATH || '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';

async function main() {
  const result = await workflow('cloud-iac-sst')
    .description(
      'Move relayfile + relayauth worker code into cloud/packages/, add SST ' +
      'Cloudflare IaC for both services. Skip relaycast (import later).'
    )
    .pattern('dag')
    .channel('wf-cloud-iac-sst')
    .maxConcurrency(4)
    .timeout(3600000)

    // ── Agents ──────────────────────────────────────────────────────────

    .agent('architect', {
      cli: 'claude',
      preset: 'lead',
      role: 'Designs the cloudflare/ infra module structure, updates sst.config.ts.',
    })
    .agent('mover', {
      cli: 'codex',
      preset: 'worker',
      role: 'Moves worker code from relayfile-cloud and relayauth into cloud/packages/.',
    })
    .agent('relayfile-dev', {
      cli: 'codex',
      preset: 'worker',
      role: 'Implements relayfile CF resources in SST matching wrangler.toml.',
    })
    .agent('relayauth-dev', {
      cli: 'codex',
      preset: 'worker',
      role: 'Implements relayauth CF resources in SST based on the architecture spec.',
    })
    .agent('integrator', {
      cli: 'claude',
      preset: 'lead',
      role: 'Wires index.ts, updates sst.config.ts, secrets.ts, and package.json workspaces.',
    })
    .agent('reviewer', {
      cli: 'claude',
      preset: 'reviewer',
      role: 'Reviews IaC, worker code migration, and wrangler config consistency.',
    })

    // ── Phase 1: Read all context (parallel) ────────────────────────────

    .step('read-sst-config', {
      type: 'deterministic',
      command: `cat ${CLOUD}/sst.config.ts`,
      captureOutput: true,
      failOnError: true,
    })
    .step('read-cloud-package-json', {
      type: 'deterministic',
      command: `cat ${CLOUD}/package.json`,
      captureOutput: true,
      failOnError: true,
    })
    .step('read-secrets', {
      type: 'deterministic',
      command: `cat ${CLOUD}/infra/secrets.ts`,
      captureOutput: true,
      failOnError: true,
    })
    .step('read-storage-pattern', {
      type: 'deterministic',
      command: `cat ${CLOUD}/infra/storage.ts`,
      captureOutput: true,
      failOnError: true,
    })
    .step('read-existing-infra-dir', {
      type: 'deterministic',
      command: `ls -la ${CLOUD}/infra/ && echo "---" && ls -la ${CLOUD}/packages/`,
      captureOutput: true,
      failOnError: true,
    })
    .step('read-relayfile-wrangler', {
      type: 'deterministic',
      command: `cat ${RELAYFILE_CLOUD}/wrangler.toml`,
      captureOutput: true,
      failOnError: true,
    })
    .step('read-relayfile-package-json', {
      type: 'deterministic',
      command: `cat ${RELAYFILE_CLOUD}/package.json`,
      captureOutput: true,
      failOnError: true,
    })
    .step('read-relayfile-worker', {
      type: 'deterministic',
      command: `cat ${RELAYFILE_CLOUD}/src/worker.ts`,
      captureOutput: true,
      failOnError: true,
    })
    .step('read-relayfile-src-listing', {
      type: 'deterministic',
      command: `find ${RELAYFILE_CLOUD}/src -type f | sort`,
      captureOutput: true,
      failOnError: true,
    })
    .step('read-relayauth-spec', {
      type: 'deterministic',
      command: `cat ${RELAYAUTH}/specs/*.md 2>/dev/null | head -120 || echo "# no specs"`,
      captureOutput: true,
      failOnError: false,
    })
    .step('read-relayauth-server-listing', {
      type: 'deterministic',
      command: `find ${RELAYAUTH}/packages/server/src -type f 2>/dev/null | sort || echo "# no server src"`,
      captureOutput: true,
      failOnError: false,
    })
    .step('read-relayauth-worker', {
      type: 'deterministic',
      command: `cat ${RELAYAUTH}/packages/server/src/worker.ts 2>/dev/null || echo "# no worker.ts"`,
      captureOutput: true,
      failOnError: false,
    })

    // ── Phase 2a: Move worker code into cloud/packages/ ─────────────────

    .step('move-workers', {
      agent: 'mover',
      dependsOn: [
        'read-relayfile-src-listing',
        'read-relayfile-package-json',
        'read-relayfile-wrangler',
        'read-relayauth-server-listing',
        'read-relayauth-worker',
        'read-cloud-package-json',
        'read-existing-infra-dir',
      ],
      task: `Move relayfile-cloud and relayauth worker code into cloud/packages/.

IMPORTANT: Use shell commands (cp, mkdir) to copy files. Do NOT rewrite them.

## Relayfile

Source: ${RELAYFILE_CLOUD}/
Destination: ${CLOUD}/packages/relayfile/

Files to copy:
{{steps.read-relayfile-src-listing.output}}

Commands to run:
1. mkdir -p ${CLOUD}/packages/relayfile
2. cp -r ${RELAYFILE_CLOUD}/src ${CLOUD}/packages/relayfile/src
3. cp ${RELAYFILE_CLOUD}/wrangler.toml ${CLOUD}/packages/relayfile/wrangler.toml
4. cp ${RELAYFILE_CLOUD}/tsconfig.json ${CLOUD}/packages/relayfile/tsconfig.json
5. cp ${RELAYFILE_CLOUD}/package.json ${CLOUD}/packages/relayfile/package.json
6. If test/ exists: cp -r ${RELAYFILE_CLOUD}/test ${CLOUD}/packages/relayfile/test
7. If vitest.config.ts exists: cp ${RELAYFILE_CLOUD}/vitest.config.ts ${CLOUD}/packages/relayfile/vitest.config.ts

Update ${CLOUD}/packages/relayfile/wrangler.toml:
- Change main to "src/worker.ts" (should already be correct)
- No other changes needed — placeholder IDs stay until SST provides real ones

## Relayauth

Source: ${RELAYAUTH}/packages/server/
Destination: ${CLOUD}/packages/relayauth/

Relayauth server files:
{{steps.read-relayauth-server-listing.output}}

Commands:
1. mkdir -p ${CLOUD}/packages/relayauth
2. cp -r ${RELAYAUTH}/packages/server/src ${CLOUD}/packages/relayauth/src
3. Copy tsconfig.json, package.json, vitest.config.ts if they exist
4. Create ${CLOUD}/packages/relayauth/wrangler.toml based on the relayauth spec:
   - name: relayauth-api
   - D1 binding: DB, database_name: relayauth, placeholder ID
   - KV binding: KV, placeholder ID
   - Durable Objects if the server has any (check src/durable-objects/)
   - Staging + preview environments matching the relayfile pattern

## Update cloud package.json

Current:
{{steps.read-cloud-package-json.output}}

The workspaces field should already include "packages/*" — verify it does.
If not, add the new packages.

Do NOT modify any source code files — just copy them as-is.`,
      verification: { type: 'exit_code' },
    })

    .step('verify-move', {
      type: 'deterministic',
      dependsOn: ['move-workers'],
      command: [
        'echo "=== relayfile package ==="',
        `ls ${CLOUD}/packages/relayfile/src/worker.ts ${CLOUD}/packages/relayfile/wrangler.toml ${CLOUD}/packages/relayfile/package.json 2>/dev/null && echo "OK" || echo "MISSING files"`,
        'echo "=== relayauth package ==="',
        `ls ${CLOUD}/packages/relayauth/src/ ${CLOUD}/packages/relayauth/wrangler.toml ${CLOUD}/packages/relayauth/package.json 2>/dev/null && echo "OK" || echo "MISSING files"`,
      ].join('; '),
      failOnError: false,
      captureOutput: true,
    })

    // ── Phase 2b: Scaffold SST cloudflare infra (parallel with move) ────

    .step('create-scaffold', {
      agent: 'architect',
      dependsOn: [
        'read-sst-config',
        'read-secrets',
        'read-storage-pattern',
        'read-existing-infra-dir',
      ],
      task: `Create the cloudflare infra module scaffold in the existing SST project.

IMPORTANT: Write ALL files to disk. Do NOT just output content to stdout.

SST config (CF provider already enabled):
{{steps.read-sst-config.output}}

Existing secrets pattern:
{{steps.read-secrets.output}}

Existing infra pattern (storage.ts — shows @pulumi/aws usage):
{{steps.read-storage-pattern.output}}

Existing directories:
{{steps.read-existing-infra-dir.output}}

## Create these files:

### 1. ${CLOUD}/infra/cloudflare/index.ts
Main entrypoint — only relayfile + relayauth. NO relaycast (will be imported later).
\`\`\`ts
import * as cloudflare from "@pulumi/cloudflare";
import { relayfileInfra } from "./relayfile";
import { relayauthInfra } from "./relayauth";

// Zone lookups
const relayfileZone = cloudflare.getZone({ name: "relayfile.dev" });
const relayauthZone = cloudflare.getZone({ name: "relayauth.dev" });

const relayfile = relayfileInfra({
  stage: $app.stage,
  zoneId: relayfileZone.then(z => z.id),
});
const relayauth = relayauthInfra({
  stage: $app.stage,
  zoneId: relayauthZone.then(z => z.id),
});

// NOTE: relaycast resources already exist in CF — they will be imported
// into SST state later via \`pulumi import\`. Do not create them here.

export const cfOutputs = { relayfile, relayauth };
\`\`\`

### 2. Placeholder files:
- ${CLOUD}/infra/cloudflare/relayfile.ts (export function relayfileInfra)
- ${CLOUD}/infra/cloudflare/relayauth.ts (export function relayauthInfra)

Each exports a typed function: \`(opts: { stage: string; zoneId: pulumi.Output<string> }) => { ... }\`

### 3. Update ${CLOUD}/infra/secrets.ts
Append (preserve existing):
\`\`\`ts
export const cloudflareAccountId = new sst.Secret("CloudflareAccountId");
export const cloudflareApiToken = new sst.Secret("CloudflareApiToken");
\`\`\`

### 4. Update ${CLOUD}/sst.config.ts
Add in run():
\`\`\`ts
const { cfOutputs } = await import("./infra/cloudflare");
\`\`\`
Add cfOutputs to return object. Preserve ALL existing code.`,
      verification: { type: 'file_exists', value: `${CLOUD}/infra/cloudflare/index.ts` },
    })

    .step('verify-scaffold', {
      type: 'deterministic',
      dependsOn: ['create-scaffold'],
      command: `missing=0; for f in ${CLOUD}/infra/cloudflare/index.ts ${CLOUD}/infra/cloudflare/relayfile.ts ${CLOUD}/infra/cloudflare/relayauth.ts; do if [ ! -f "$f" ]; then echo "MISSING: $f"; missing=$((missing+1)); fi; done; if [ $missing -gt 0 ]; then echo "$missing files missing"; exit 1; fi; echo "Scaffold OK"`,
      failOnError: true,
      captureOutput: true,
    })

    .step('read-index-ts', {
      type: 'deterministic',
      dependsOn: ['verify-scaffold'],
      command: `cat ${CLOUD}/infra/cloudflare/index.ts`,
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 3: Implement per-service IaC (parallel) ───────────────────

    .step('implement-relayfile', {
      agent: 'relayfile-dev',
      dependsOn: ['read-index-ts', 'read-relayfile-wrangler'],
      task: `Implement ${CLOUD}/infra/cloudflare/relayfile.ts with all CF resources for relayfile.

IMPORTANT: Write the file to disk at ${CLOUD}/infra/cloudflare/relayfile.ts.

Index module (match this function signature):
{{steps.read-index-ts.output}}

Relayfile wrangler.toml (source of truth — every resource here needs an SST equivalent):
{{steps.read-relayfile-wrangler.output}}

Use \`import * as cloudflare from "@pulumi/cloudflare"\` and create resources
for the current stage ($app.stage). Use stage-aware naming:
- production: "relayfile", "relayfile-content", etc.
- staging: "relayfile-staging", "relayfile-content-staging", etc.
- dev: "relayfile-{stage}", etc.

Resources to create:

1. **D1 Database**: \`new cloudflare.D1Database\`
2. **KV Namespace**: \`new cloudflare.WorkersKvNamespace\`
3. **R2 Bucket**: \`new cloudflare.R2Bucket\`
   - "relayfile-content" / "relayfile-content-{stage}"
4. **Queues**: \`new cloudflare.Queue\`
   - relayfile-envelopes, relayfile-envelopes-dlq
   - relayfile-writeback
5. **DNS Records**: \`new cloudflare.Record\`
   - api.relayfile.dev (AAAA 100:: proxied)
   - staging-api.relayfile.dev (only if staging)

Export function returning object with all resource IDs/names.
Get accountId from the cloudflare provider config or pass as param.`,
      verification: { type: 'exit_code' },
    })

    .step('implement-relayauth', {
      agent: 'relayauth-dev',
      dependsOn: ['read-index-ts', 'read-relayauth-spec'],
      task: `Implement ${CLOUD}/infra/cloudflare/relayauth.ts with CF resources for relayauth.

IMPORTANT: Write the file to disk at ${CLOUD}/infra/cloudflare/relayauth.ts.

Index module (match this function signature):
{{steps.read-index-ts.output}}

Relayauth architecture spec:
{{steps.read-relayauth-spec.output}}

Resources to create (stage-aware naming, same pattern as relayfile):

1. **D1 Database**: "relayauth" / "relayauth-{stage}"
2. **KV Namespace**: "relayauth-kv" / "relayauth-kv-{stage}"
3. **DNS Records**:
   - api.relayauth.dev (AAAA 100:: proxied)
   - staging-api.relayauth.dev (only if staging)

No R2 or Queues — auth is request/response backed by D1+KV.

Export function returning object with resource IDs/names.
Follow the same patterns as relayfile.ts.`,
      verification: { type: 'exit_code' },
    })

    // ── Phase 4: Integrate + typecheck ──────────────────────────────────

    .step('verify-all-files', {
      type: 'deterministic',
      dependsOn: ['implement-relayfile', 'implement-relayauth', 'verify-move'],
      command: `missing=0; for f in ${CLOUD}/infra/cloudflare/relayfile.ts ${CLOUD}/infra/cloudflare/relayauth.ts ${CLOUD}/packages/relayfile/wrangler.toml ${CLOUD}/packages/relayauth/wrangler.toml; do if [ ! -f "$f" ]; then echo "MISSING: $f"; missing=$((missing+1)); fi; done; if [ $missing -gt 0 ]; then echo "$missing files missing"; exit 1; fi; echo "All files present"`,
      failOnError: true,
      captureOutput: true,
    })

    .step('read-all-files', {
      type: 'deterministic',
      dependsOn: ['verify-all-files'],
      command: [
        `echo "=== sst.config.ts ==="`,
        `cat ${CLOUD}/sst.config.ts`,
        `echo "=== secrets.ts ==="`,
        `cat ${CLOUD}/infra/secrets.ts`,
        `echo "=== cloudflare/index.ts ==="`,
        `cat ${CLOUD}/infra/cloudflare/index.ts`,
        `echo "=== cloudflare/relayfile.ts ==="`,
        `cat ${CLOUD}/infra/cloudflare/relayfile.ts`,
        `echo "=== cloudflare/relayauth.ts ==="`,
        `cat ${CLOUD}/infra/cloudflare/relayauth.ts`,
        `echo "=== packages/relayfile/wrangler.toml ==="`,
        `cat ${CLOUD}/packages/relayfile/wrangler.toml`,
        `echo "=== packages/relayauth/wrangler.toml ==="`,
        `cat ${CLOUD}/packages/relayauth/wrangler.toml`,
      ].join('; '),
      captureOutput: true,
      failOnError: true,
    })

    .step('integrate', {
      agent: 'integrator',
      dependsOn: ['read-all-files'],
      task: `Wire everything together and make it typecheck.

IMPORTANT: Write all updated files to disk.

Current state:
{{steps.read-all-files.output}}

Tasks:

1. Ensure ${CLOUD}/infra/cloudflare/index.ts properly imports relayfile
   and relayauth modules (NOT relaycast) and passes the right params.

2. Ensure ${CLOUD}/sst.config.ts imports the cloudflare module:
   \`const { cfOutputs } = await import("./infra/cloudflare");\`
   and includes cfOutputs in the return value. Preserve ALL existing code.

3. Ensure ${CLOUD}/infra/secrets.ts has CloudflareAccountId and
   CloudflareApiToken appended (not replacing existing secrets).

4. Ensure ${CLOUD}/package.json workspaces includes packages/* (should already).

5. Ensure consistent patterns between relayfile.ts and relayauth.ts:
   - Same function signature
   - Same naming convention
   - Same return type structure

6. Update wrangler.toml files in packages/relayfile/ and packages/relayauth/
   to add a comment at the top:
   \`# Resource IDs provisioned by SST — see infra/cloudflare/\`

7. Create ${CLOUD}/infra/cloudflare/README.md explaining:
   - Only manages relayfile + relayauth CF resources
   - Relaycast will be imported later via \`pulumi import\`
   - Prerequisites: sst secret set CloudflareAccountId, sst secret set CloudflareApiToken
   - Deploy: sst deploy --stage production
   - Worker deploy: cd packages/relayfile && npx wrangler deploy
   - How to read SST outputs for wrangler placeholder replacement
   - Migration: after relayfile-cloud is archived, all code lives here

8. Run typecheck: cd ${CLOUD} && npx tsc --noEmit
   Fix any type errors.`,
      verification: { type: 'exit_code' },
    })

    .step('typecheck', {
      type: 'deterministic',
      dependsOn: ['integrate'],
      command: `cd ${CLOUD} && npx tsc --noEmit 2>&1 | tail -20; echo "EXIT: $?"`,
      captureOutput: true,
      failOnError: false,
    })

    // ── Phase 5: Review ─────────────────────────────────────────────────

    .step('capture-diff', {
      type: 'deterministic',
      dependsOn: ['typecheck'],
      command: `cd ${CLOUD} && git diff --stat && echo "---FULL DIFF---" && git diff infra/ sst.config.ts packages/relayfile/ packages/relayauth/`,
      captureOutput: true,
      failOnError: false,
    })

    .step('review', {
      agent: 'reviewer',
      dependsOn: ['capture-diff', 'typecheck'],
      task: `Review the SST Cloudflare IaC and worker code migration.

Typecheck result:
{{steps.typecheck.output}}

Diff:
{{steps.capture-diff.output}}

Review checklist:

Worker code migration:
1. packages/relayfile/ has worker.ts, wrangler.toml, package.json
2. packages/relayauth/ has worker.ts (or index.ts), wrangler.toml, package.json
3. Source code is copied verbatim — no modifications
4. Wrangler configs match the originals

SST integration:
5. sst.config.ts imports cloudflare module, adds cfOutputs to return
6. secrets.ts has CloudflareAccountId + CloudflareApiToken (appended)
7. No breaking changes to existing AWS infra (vpc, database, storage, etc.)

Relayfile IaC (must match wrangler.toml):
8. D1: relayfile + staging
9. KV: both envs
10. R2: relayfile-content + staging
11. Queues: envelopes (+DLQ), writeback — both envs
12. DNS: api.relayfile.dev, staging-api

Relayauth IaC:
13. D1: relayauth + staging
14. KV: both envs
15. DNS: api.relayauth.dev, staging-api
16. No R2 or Queues (correct)

Relaycast:
17. NOT included in IaC (correct — import later)
18. No references to relaycast resources in cloudflare/ module

Security:
19. No hardcoded tokens or account IDs
20. CF credentials via sst.Secret

If issues found, list with file:line references.`,
    })

    .onError('retry', { maxRetries: 1, retryDelayMs: 10000 })
    .run({
      onEvent: (e: any) => console.log(`[${e.type}] ${e.step ?? ''}`),
    });

  console.log('Result:', result.status);
}

main().catch(console.error);
