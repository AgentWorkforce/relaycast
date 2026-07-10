/**
 * distributed-relay-access.ts
 *
 * Build distributed agent file access for the CLOUD (paid service).
 * Extracts @relayauth/core from OSS, wires it into cloud orchestration,
 * adds WebSocket sync SDK for multi-agent real-time coordination.
 *
 * Team pattern: claude architect + 3 codex workers via channel.
 * 3 phases: context → build team → verify+fix.
 *
 * Run: agent-relay run workflows/distributed-relay-access.ts
 */

import { workflow } from '@relayflows/core';

const CLOUD = '/Users/khaliqgant/Projects/AgentWorkforce/cloud';
const RELAYAUTH = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('distributed-relay-access')
  .description('Build distributed agent file access: @relayauth/core + cloud wiring + WebSocket sync')
  .pattern('dag')
  .channel('wf-distributed-relay')
  .maxConcurrency(5)
  .timeout(3_600_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Designs package boundaries, assigns work to core-impl/cloud-impl/sdk-impl via #wf-distributed-relay, reviews integration',
    cwd: CLOUD,
  })
  .agent('core-impl', {
    cli: 'codex',
    preset: 'worker',
    role: 'Extracts @relayauth/core package (token verify, scope parsing, ACL eval)',
    cwd: RELAYAUTH,
  })
  .agent('cloud-impl', {
    cli: 'codex',
    preset: 'worker',
    role: 'Builds RelayFileAccessManager and RelayAgentEnvironment in cloud/packages/core',
    cwd: CLOUD,
  })
  .agent('sdk-impl', {
    cli: 'codex',
    preset: 'worker',
    role: 'Builds RelayFileSync WebSocket client in relayfile SDK',
    cwd: RELAYFILE,
  })

  // ═══════════════════════════════════════════════════════════════
  // PHASE 1: Read context from all three repos
  // ═══════════════════════════════════════════════════════════════

  .step('read-relayauth-context', {
    type: 'deterministic',
    command: `echo "=== SDK CLIENT ===" && head -80 ${RELAYAUTH}/packages/sdk/src/client.ts && echo "=== SCOPE PARSER ===" && head -60 ${RELAYAUTH}/packages/sdk/src/scope-parser.ts 2>/dev/null && echo "=== SCOPE MATCHER ===" && head -60 ${RELAYAUTH}/packages/sdk/src/scope-matcher.ts 2>/dev/null && echo "=== TOKEN TYPES ===" && cat ${RELAYAUTH}/packages/types/src/token.ts && echo "=== SCOPE TYPES ===" && head -60 ${RELAYAUTH}/packages/types/src/scope.ts && echo "=== AUTH LIB ===" && head -80 ${RELAYAUTH}/packages/server/src/lib/auth.ts && echo "=== AI ADAPTER ===" && head -40 ${RELAYAUTH}/packages/ai/src/adapter.ts`,
    captureOutput: true,
  })

  .step('read-cloud-context', {
    type: 'deterministic',
    command: `echo "=== ARCHITECTURE ===" && cat ${CLOUD}/ARCHITECTURE.md && echo "=== CORE INDEX ===" && head -50 ${CLOUD}/packages/core/src/index.ts 2>/dev/null || echo "NO INDEX" && echo "=== CORE PKG ===" && cat ${CLOUD}/packages/core/package.json 2>/dev/null || echo "NO PKG" && echo "=== CLOUD RELAYAUTH PKG ===" && cat ${CLOUD}/packages/relayauth/package.json 2>/dev/null || echo "NONE"`,
    captureOutput: true,
  })

  .step('read-relayfile-context', {
    type: 'deterministic',
    command: `echo "=== SDK CLIENT ===" && head -80 ${RELAYFILE}/packages/sdk/src/client.ts && echo "=== SDK INDEX ===" && head -30 ${RELAYFILE}/packages/sdk/src/index.ts && echo "=== ACL ===" && cat ${RELAYFILE}/packages/core/src/acl.ts`,
    captureOutput: true,
  })

  // ═══════════════════════════════════════════════════════════════
  // PHASE 2: Architect + workers concurrently
  // ═══════════════════════════════════════════════════════════════

  .step('architect-coordinate', {
    agent: 'architect',
    dependsOn: ['read-relayauth-context', 'read-cloud-context', 'read-relayfile-context'],
    task: `Lead the distributed relay access implementation. Workers: core-impl, cloud-impl, sdk-impl.

RELAYAUTH:
{{steps.read-relayauth-context.output}}

CLOUD:
{{steps.read-cloud-context.output}}

RELAYFILE:
{{steps.read-relayfile-context.output}}

Design and assign via #wf-distributed-relay:

**core-impl** gets: Extract @relayauth/core + dedup cloud/relayauth
- Create ${RELAYAUTH}/packages/core/ with package.json (@relayauth/core, zero runtime deps)
- Move from SDK: token-verify.ts, scope-parser.ts, scope-matcher.ts, scope-checker.ts
- Port from relayfile: acl.ts (ACL evaluation)
- Barrel export from index.ts
- Update SDK to re-export from core (backwards compatible)

**cloud-impl** gets: Dedup cloud/relayauth + wire into cloud orchestration

CRITICAL: cloud/packages/relayauth is currently a byte-for-byte copy of
the OSS relayauth server (26 duplicated source files). This MUST be fixed.
cloud/relayfile already does it right — thin proxy importing from OSS packages.

Step 1 — Refactor cloud/relayauth to import from OSS:
- Delete ALL duplicated source files from ${CLOUD}/packages/relayauth/src/
  (routes/, engine/, middleware/, lib/, durable-objects/ — everything that
  exists identically in the OSS relayauth/packages/server/)
- Replace with imports from @relayauth/core (for logic) and @relayauth/sdk (for types/client)
- Keep ONLY cloud-specific additions:
  - Multi-tenancy wrappers (org isolation, workspace scoping)
  - Billing hooks (usage metering per identity)
  - Credential encryption layer (AES-256-GCM for provider tokens)
  - Any cloud-specific middleware (e.g., Cloudflare-specific bindings that differ from OSS)
- The worker.ts entry point should import routes from OSS and wrap with cloud middleware
- Add @relayauth/core and @relayauth/sdk as dependencies in package.json

Step 2 — Cloud orchestration modules:
- ${CLOUD}/packages/core/src/relay-file-access.ts — RelayFileAccessManager class
  - provisionAgent(name, scopes, dotfileRules) → { relayfileUrl, token, workspace, wsUrl }
  - seedFromSource(workspaceId, source) for S3/git seeding
  - revokeAgent(token)
- ${CLOUD}/packages/core/src/relay-agent-env.ts — RelayAgentEnvironment class
  - create(access, opts) → { env vars, tool definitions, fuseMount config }
  - Support for containerMode + aiProvider options

**sdk-impl** gets: WebSocket sync client for relayfile SDK
- ${RELAYFILE}/packages/sdk/src/sync.ts — RelayFileSync class
  - connect() to /v1/workspaces/{ws}/fs/ws
  - on('file.created'|'file.updated'|'file.deleted', handler)
  - Auto-reconnect with exponential backoff (1s → 30s max)
  - disconnect()
- Export from SDK index.ts
- Add sync test file

Post specs to #wf-distributed-relay with exact file paths, types, and method signatures.
Review worker output. Ensure @relayauth/core exports are correct and cloud can import them.`,
  })

  .step('core-impl-work', {
    agent: 'core-impl',
    dependsOn: ['read-relayauth-context'],
    task: `Join #wf-distributed-relay. architect will post your assignment.
Create the @relayauth/core package at ${RELAYAUTH}/packages/core/ as directed.
IMPORTANT: Write files to disk, do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .step('cloud-impl-work', {
    agent: 'cloud-impl',
    dependsOn: ['read-cloud-context'],
    task: `Join #wf-distributed-relay. architect will post your assignment.
Dedup cloud/relayauth (delete duplicated OSS files, import from @relayauth/core instead).
Then create relay-file-access.ts and relay-agent-env.ts in ${CLOUD}/packages/core/src/.
IMPORTANT: Write files to disk, do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .step('sdk-impl-work', {
    agent: 'sdk-impl',
    dependsOn: ['read-relayfile-context'],
    task: `Join #wf-distributed-relay. architect will post your assignment.
Create the RelayFileSync WebSocket client at ${RELAYFILE}/packages/sdk/src/sync.ts as directed.
IMPORTANT: Write files to disk, do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  // ═══════════════════════════════════════════════════════════════
  // PHASE 3: Verify + fix
  // ═══════════════════════════════════════════════════════════════

  .step('verify-core', {
    type: 'deterministic',
    dependsOn: ['architect-coordinate'],
    command: `echo "=== CORE PACKAGE ===" && test -f ${RELAYAUTH}/packages/core/package.json && echo "EXISTS" || echo "MISSING" && echo "=== CORE INDEX ===" && test -f ${RELAYAUTH}/packages/core/src/index.ts && echo "EXISTS" || echo "MISSING" && echo "=== CORE BUILD ===" && cd ${RELAYAUTH} && npx turbo build --filter=@relayauth/core 2>&1 | tail -10; echo "CORE_BUILD: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('verify-cloud', {
    type: 'deterministic',
    dependsOn: ['architect-coordinate'],
    command: `echo "=== RELAY FILE ACCESS ===" && test -f ${CLOUD}/packages/core/src/relay-file-access.ts && echo "EXISTS" || echo "MISSING" && echo "=== RELAY AGENT ENV ===" && test -f ${CLOUD}/packages/core/src/relay-agent-env.ts && echo "EXISTS" || echo "MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('verify-sdk', {
    type: 'deterministic',
    dependsOn: ['architect-coordinate'],
    command: `echo "=== SYNC MODULE ===" && test -f ${RELAYFILE}/packages/sdk/src/sync.ts && echo "EXISTS" || echo "MISSING" && echo "=== EXPORTS ===" && grep -c "sync\|RelayFileSync" ${RELAYFILE}/packages/sdk/src/index.ts 2>/dev/null || echo "NOT EXPORTED"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('fix-and-finalize', {
    agent: 'architect',
    dependsOn: ['verify-core', 'verify-cloud', 'verify-sdk'],
    task: `Verify and fix the distributed relay implementation.

CORE:
{{steps.verify-core.output}}

CLOUD:
{{steps.verify-cloud.output}}

SDK:
{{steps.verify-sdk.output}}

Fix any missing files or build failures.
Ensure @relayauth/core builds and exports: verifyToken, ScopeChecker, parseScope, matchScope, filePermissionAllows.
Ensure cloud modules import from @relayauth/core correctly.

Summarize: what packages were created, the distributed access flow, remaining work.`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
  .run({
    cwd: CLOUD,
    onEvent: (e) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\nDistributed Relay Access: ${result.status}`);
}

main().catch(console.error);
