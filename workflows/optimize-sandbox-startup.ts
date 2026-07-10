/**
 * optimize-sandbox-startup.ts
 *
 * Optimizes cloud sandbox cold start time using Daytona snapshots.
 *
 * Current flow (slow, ~60s):
 *   daytona.create() → npm install deps → upload orchestrator lib
 *   → configure CLIs → upload env + script → download code → run
 *
 * After this workflow (fast, ~5-10s):
 *   daytona.create({ snapshot: 'relay-orchestrator' }) → upload env + script
 *   → download code → run
 *
 * Changes:
 *   1. Add snapshot creation script (scripts/create-snapshot.ts)
 *   2. Update launcher to use snapshot, skip redundant setup
 *   3. Add snapshot version tracking
 *
 * Run: agent-relay run workflows/optimize-sandbox-startup.ts
 */

import { workflow } from '@relayflows/core';

const FILES = {
  launcher: 'packages/core/src/bootstrap/launcher.ts',
  scriptGen: 'packages/core/src/bootstrap/script-generator.ts',
  executor: 'packages/core/src/executor/executor.ts',
  snapshotScript: 'scripts/create-snapshot.ts',
  credentials: 'packages/core/src/auth/credentials.ts',
};

const result = await workflow('optimize-sandbox-startup')
    .description('Use Daytona snapshots to eliminate sandbox cold start overhead')
    .pattern('pipeline')
    .channel('wf-optimize-sandbox')
    .maxConcurrency(2)
    .timeout(3600000)

    .agent('dev', {
      cli: 'claude',
      role: 'Implements snapshot-based sandbox startup optimization',
    })

    // ── Step 1: Create snapshot script ───────────────────────────────────

    .step('read-snapshot-script', {
      type: 'deterministic',
      command: `cat ${FILES.snapshotScript}`,
      captureOutput: true,
    })

    .step('create-snapshot-script', {
      agent: 'dev',
      dependsOn: ['read-snapshot-script'],
      task: `Create the file scripts/create-snapshot.ts

This script creates a Daytona sandbox snapshot with all dependencies
pre-installed. Run it once (or in CI) to create/update the snapshot.

Current snapshot script for reference:
{{steps.read-snapshot-script.output}}

Write a TypeScript script that:

\`\`\`typescript
/**
 * scripts/create-snapshot.ts
 *
 * Creates a Daytona snapshot with all orchestrator dependencies pre-installed.
 * Run after SDK version bumps, CLI updates, or orchestrator lib changes.
 *
 * Usage:
 *   npx tsx scripts/create-snapshot.ts
 *   npx tsx scripts/create-snapshot.ts --name relay-orchestrator-v2
 */
import { Daytona } from '@daytonaio/sdk';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SNAPSHOT_NAME = process.argv.includes('--name')
  ? process.argv[process.argv.indexOf('--name') + 1]
  : 'relay-orchestrator';

async function main() {
  const daytona = new Daytona({
    apiKey: process.env.DAYTONA_API_KEY,
    jwtToken: process.env.DAYTONA_JWT_TOKEN,
    organizationId: process.env.DAYTONA_ORGANIZATION_ID,
  });

  console.log(\`Creating sandbox for snapshot "\${SNAPSHOT_NAME}"...\`);
  const sandbox = await daytona.create({
    language: 'javascript',
    autoStopInterval: 30,
  }, { timeout: 120 });

  const home = (await sandbox.getUserHomeDir()) ?? '/home/daytona';
  console.log(\`Sandbox \${sandbox.id} created. Home: \${home}\`);

  // 1. Install all orchestrator runtime deps
  console.log('Installing orchestrator dependencies...');
  const deps = [
    '@aws-sdk/client-s3',
    '@aws-sdk/client-sts',
    '@agent-relay/sdk',
    '@agent-relay/config',
    '@daytonaio/sdk',
    'tar',
    'ignore',
  ].join(' ');

  let result = await sandbox.process.executeCommand(
    \`cd \${home} && npm init -y 2>/dev/null && npm install \${deps} 2>&1 | tail -5\`,
    home,
    undefined,
    120,
  );
  if (result.exitCode !== 0) throw new Error(\`Dep install failed: \${result.result}\`);

  // 2. Upload orchestrator lib tarball
  console.log('Uploading orchestrator lib...');
  const libCandidates = [
    path.join(__dirname, '..', 'packages', 'web', 'public', 'orchestrator-lib.tar.gz'),
    path.join(__dirname, '..', 'public', 'orchestrator-lib.tar.gz'),
  ];
  let libBuf: Buffer | null = null;
  for (const candidate of libCandidates) {
    try { libBuf = readFileSync(candidate); break; } catch { /* try next */ }
  }
  if (libBuf) {
    await sandbox.fs.uploadFile(libBuf, \`\${home}/orchestrator-lib.tar.gz\`);
    result = await sandbox.process.executeCommand(
      \`cd \${home} && tar xzf orchestrator-lib.tar.gz && rm orchestrator-lib.tar.gz\`,
      home,
    );
    if (result.exitCode !== 0) console.warn('Lib extraction failed (non-fatal)');
  } else {
    console.warn('orchestrator-lib.tar.gz not found — skipping (will be uploaded at runtime)');
  }

  // 3. Configure CLI tools (claude, codex)
  console.log('Configuring CLI tools...');

  // Codex: trust directories
  const codexConfig = [
    '[projects]',
    \`"\${home}" = { trust_level = "trusted" }\`,
    '"/project" = { trust_level = "trusted" }',
  ].join('\\n') + '\\n';
  await sandbox.process.executeCommand(\`mkdir -p \${home}/.codex\`);
  await sandbox.fs.uploadFile(Buffer.from(codexConfig), \`\${home}/.codex/config.toml\`);

  // Claude: auto-approve tools, skip onboarding
  const claudeSettings = JSON.stringify({
    permissions: {
      allow: [
        'Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep',
        'Task', 'WebFetch', 'WebSearch', 'NotebookEdit', 'TodoWrite',
        'mcp__relaycast__*',
      ],
      deny: [],
    },
    autoApproveApiRequest: true,
  }, null, 2);
  await sandbox.process.executeCommand(\`mkdir -p \${home}/.claude\`);
  await sandbox.fs.uploadFile(Buffer.from(claudeSettings), \`\${home}/.claude/settings.json\`);

  const claudeConfig = JSON.stringify({
    hasCompletedOnboarding: true,
    firstStartTime: new Date().toISOString(),
  });
  await sandbox.fs.uploadFile(Buffer.from(claudeConfig), \`\${home}/.claude.json\`);

  // Git config
  await sandbox.process.executeCommand(
    'git config --global user.email "agent@agent-relay.com" && git config --global user.name "Agent Relay"',
  );

  // 4. Create the snapshot
  console.log(\`Creating snapshot "\${SNAPSHOT_NAME}"...\`);
  await daytona.snapshot(sandbox, { name: SNAPSHOT_NAME });
  console.log(\`Snapshot "\${SNAPSHOT_NAME}" created successfully.\`);

  // 5. Clean up the sandbox
  console.log('Cleaning up sandbox...');
  await daytona.delete(sandbox);

  console.log('Done. Use in launcher with:');
  console.log(\`  daytona.create({ snapshot: '\${SNAPSHOT_NAME}' })\`);
}

main().catch((err) => {
  console.error('Snapshot creation failed:', err);
  process.exit(1);
});
\`\`\`

IMPORTANT: Write this file to disk at scripts/create-snapshot.ts.
Only create this one file.`,
      verification: { type: 'file_exists', value: 'scripts/create-snapshot.ts' },
    })

    // ── Step 2: Update launcher to use snapshot ─────────────────────────

    .step('read-launcher', {
      type: 'deterministic',
      dependsOn: ['create-snapshot-script'],
      command: `cat ${FILES.launcher}`,
      captureOutput: true,
    })

    .step('edit-launcher', {
      agent: 'dev',
      dependsOn: ['read-launcher'],
      task: `Edit the file ${FILES.launcher}

Current contents:
{{steps.read-launcher.output}}

Make these changes to use Daytona snapshots for faster startup:

1. Add a constant at the top (after imports):
   const SNAPSHOT_NAME = process.env.RELAY_SANDBOX_SNAPSHOT || 'relay-orchestrator';

2. Add \`snapshot?: string\` to the LaunchOptions interface.

3. In launchOrchestratorSandbox(), change the daytona.create() call:
   Before:
     const sandbox = await daytona.create({
       language: "javascript",
       autoStopInterval: 60,
       ...(codeVolume ? { volumes: [...] } : {}),
     }, { timeout: 120 });

   After:
     const snapshotName = options.snapshot ?? SNAPSHOT_NAME;
     let sandbox: Sandbox;
     try {
       // Try snapshot-based creation first (fast path)
       sandbox = await daytona.create({
         snapshot: snapshotName,
         autoStopInterval: 60,
         ...(codeVolume ? { volumes: [volumeManager.mountConfig(codeVolume.id, "/project")] } : {}),
       }, { timeout: 120 });
       console.log(\`[launcher] Created sandbox from snapshot "\${snapshotName}"\`);
     } catch (snapshotErr) {
       // Snapshot not found — fall back to fresh sandbox
       console.warn(\`[launcher] Snapshot "\${snapshotName}" not found, falling back to fresh sandbox\`);
       sandbox = await daytona.create({
         language: "javascript",
         autoStopInterval: 60,
         ...(codeVolume ? { volumes: [volumeManager.mountConfig(codeVolume.id, "/project")] } : {}),
       }, { timeout: 120 });
     }

4. After the sandbox creation, conditionally skip setup steps if snapshot was used:
   Wrap the existing dep install, lib upload, and CLI config blocks in a check:

     // Check if deps are already present (snapshot includes them)
     const depsCheck = await sandbox.process.executeCommand(
       'node -e "require(\'@agent-relay/sdk\')" 2>/dev/null',
       home,
     );
     const needsSetup = depsCheck.exitCode !== 0;

     if (needsSetup) {
       // Existing dep install block...
       // Existing uploadLibDirectory call...
       // Existing configureSandboxCLIs call...
     } else {
       console.log('[launcher] Snapshot has deps pre-installed — skipping setup');
     }

   Keep the existing code inside the if block unchanged. Just wrap it.

5. The rest of the function (env vars, bootstrap script upload, launch) stays the same
   — those are per-run and can't be pre-baked.

Only edit this one file.`,
      verification: { type: 'exit_code' },
    })

    .step('verify-launcher', {
      type: 'deterministic',
      dependsOn: ['edit-launcher'],
      command: `if git diff --quiet ${FILES.launcher}; then echo "NOT MODIFIED"; exit 1; fi
echo "OK: launcher modified"
git diff --stat ${FILES.launcher}`,
      captureOutput: true,
      failOnError: true,
    })

    // ── Step 3: Update executor for step sandboxes ──────────────────────

    .step('read-executor', {
      type: 'deterministic',
      dependsOn: ['verify-launcher'],
      command: `cat ${FILES.executor}`,
      captureOutput: true,
    })

    .step('edit-executor', {
      agent: 'dev',
      dependsOn: ['read-executor'],
      task: `Edit the file ${FILES.executor}

Current contents:
{{steps.read-executor.output}}

The DaytonaStepExecutor creates per-step sandboxes for non-interactive agents.
These should also use snapshots when available.

Make these changes:

1. Add a snapshot property to the class:
   private snapshot?: string;

2. Accept it in the constructor (alongside existing params):
   Add snapshot?: string to whatever options/params the constructor takes.

3. When creating per-step sandboxes (look for daytona.create calls in executeAgentStep):
   Add the snapshot parameter:
     const sandbox = await this.daytona.create({
       snapshot: this.snapshot,  // add this line
       // ... keep existing options
     });

   If the create with snapshot fails, fall back to without:
     try {
       sandbox = await this.daytona.create({ snapshot: this.snapshot, ... });
     } catch {
       sandbox = await this.daytona.create({ /* without snapshot */ ... });
     }

4. In the step sandbox setup, add the same deps check to skip CLI install if snapshot has it:
     const hasCli = await sandbox.process.executeCommand(\`which \${agentDef.cli} 2>/dev/null\`);
     if (hasCli.exitCode !== 0) {
       await this.ensureCliInstalled(sandbox, provider);
     }

Only edit this one file.`,
      verification: { type: 'exit_code' },
    })

    .step('verify-executor', {
      type: 'deterministic',
      dependsOn: ['edit-executor'],
      command: `if git diff --quiet ${FILES.executor}; then echo "NOT MODIFIED"; exit 1; fi
echo "OK: executor modified"
git diff --stat ${FILES.executor}`,
      captureOutput: true,
      failOnError: true,
    })

    // ── Step 4: Build check ─────────────────────────────────────────────

    .step('build-check', {
      type: 'deterministic',
      dependsOn: ['verify-executor'],
      command: 'npx tsc --noEmit 2>&1 | tail -20; echo "EXIT: $?"',
      captureOutput: true,
      failOnError: false,
    })

    .step('fix-build', {
      agent: 'dev',
      dependsOn: ['build-check'],
      task: `Check the TypeScript build output and fix any errors.

Build output:
{{steps.build-check.output}}

If the build passed (EXIT: 0), do nothing.
If there are errors, read the failing files and fix them.
Then verify: npx tsc --noEmit`,
      verification: { type: 'exit_code' },
    })

    // ── Step 5: Commit ──────────────────────────────────────────────────

    .step('check-diff', {
      type: 'deterministic',
      dependsOn: ['fix-build'],
      command: 'echo "Modified files:" && git diff --name-only && echo "" && git diff --stat',
      captureOutput: true,
      failOnError: false,
    })

    .step('commit', {
      type: 'deterministic',
      dependsOn: ['check-diff'],
      command: `git add scripts/create-snapshot.ts ${FILES.launcher} ${FILES.executor} && \
git diff --cached --name-only && \
git commit -m "perf: use Daytona snapshots for instant sandbox startup

Add scripts/create-snapshot.ts to build a pre-configured sandbox snapshot
with all deps, orchestrator lib, and CLI configs pre-installed.

Launcher and executor now try snapshot-based creation first (fast path)
with automatic fallback to fresh sandbox if snapshot not found.

Expected cold start improvement: ~60s → ~5-10s.

Usage:
  npx tsx scripts/create-snapshot.ts
  # Then all workflow runs use the snapshot automatically"`,
      captureOutput: true,
      failOnError: true,
    })

    .step('verify-commit', {
      type: 'deterministic',
      dependsOn: ['commit'],
      command: 'git log --oneline -1 && echo "" && git diff-tree --no-commit-id --name-only -r HEAD',
      captureOutput: true,
      failOnError: true,
    })

    .onError('retry', { maxRetries: 2, retryDelayMs: 10000 })
    .run({ cwd: process.cwd() });

console.log(`\nOptimize sandbox startup workflow: ${result.status}`);
if (result.status === 'completed') {
  console.log('\nFiles:');
  console.log('  - scripts/create-snapshot.ts (new)');
  console.log('  - packages/core/src/bootstrap/launcher.ts (updated)');
  console.log('  - packages/core/src/executor/executor.ts (updated)');
  console.log('\nNext steps:');
  console.log('  1. npx tsx scripts/create-snapshot.ts');
  console.log('  2. All subsequent workflow runs use the snapshot automatically');
}
