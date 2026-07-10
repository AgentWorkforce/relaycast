/**
 * Cloud Workflow Orchestration — Multi-Agent Build Workflow
 *
 * 3 phases building the cloud execution stack:
 *   Phase 1: Foundation (auth, volumes, storage — independent modules)
 *   Phase 2: Orchestration (executor, bootstrap — depend on Phase 1)
 *   Phase 3: API + Integration (web routes, reporter, barrel exports)
 *
 * Pattern: DAG with file-check gates and one lead review per phase.
 * All agents work on the ../relay codebase.
 */

import { WorkflowRunner, InMemoryWorkflowDb } from "@relayflows/core";
import type { RelayYamlConfig } from "@relayflows/core";

const RELAY = "../relay";
const SDK = `${RELAY}/packages/sdk/src/workflows`;
const LIB = `${SDK}/lib`;
const WEB = `${RELAY}/packages/web`;

const PHASE_REVIEW = `
Rate the phase: APPROVED or CHANGES_REQUESTED.
List any issues found with severity (critical/major/minor).
State your verdict clearly.
`.trim();

export const config: RelayYamlConfig = {
  version: "1.0",
  name: "cloud-orchestration",
  description:
    "Builds the cloud execution stack: auth, volumes, S3 storage, step executor, bootstrap, web API, and reporter.",
  swarm: {
    pattern: "dag",
    maxConcurrency: 5,
    timeoutMs: 3_600_000,
    channel: "wf-cloud-orchestration",
  },
  agents: [
    {
      name: "lead",
      cli: "claude",
      preset: "lead",
      role: "Architecture planning, phase reviews, and final verdicts",
    },
    {
      name: "codex-1",
      cli: "codex",
      preset: "worker",
      role: "Primary implementer",
    },
    {
      name: "codex-2",
      cli: "codex",
      preset: "worker",
      role: "Secondary implementer",
    },
    {
      name: "codex-3",
      cli: "codex",
      preset: "worker",
      role: "Tertiary implementer",
    },
  ],
  workflows: [
    {
      name: "cloud-orchestration-flow",
      steps: [
        // ═══════════════════════════════════════════════════════════════
        // Phase 1: Foundation
        // Creates: lib/auth/credentials.ts
        //          lib/auth/s3-credentials.ts
        //          lib/auth/cli-credentials.ts
        //          lib/volumes/manager.ts
        //          lib/storage/client.ts
        //          lib/storage/log-streamer.ts
        //          lib/storage/metadata.ts
        //          lib/storage/code-transfer.ts
        // ═══════════════════════════════════════════════════════════════

        {
          name: "p1-read-context",
          type: "deterministic",
          command: [
            `head -120 ${RELAY}/src/cli/lib/connect-daytona.ts`,
            `echo '---SEPARATOR---'`,
            `head -50 ${SDK}/runner.ts`,
            `echo '---SEPARATOR---'`,
            `head -80 ${RELAY}/packages/sdk/src/spawn-from-env.ts`,
            `echo '---SEPARATOR---'`,
            `head -60 lib/code-sync/sync.ts`,
          ].join(" && "),
          captureOutput: true,
        },
        {
          name: "p1-lead-plan",
          type: "agent",
          agent: "lead",
          dependsOn: ["p1-read-context"],
          task: `
Design ALL foundation modules for cloud execution. Read the context from the previous step.

Eight files to design:

## Auth (3 files)

1. ${LIB}/auth/credentials.ts — CredentialBundle type
   - S3Credentials interface (accessKeyId, secretAccessKey, sessionToken, bucket, prefix)
   - CredentialBundle interface (full set for orchestrator sandbox — includes s3Credentials,
     cliCredentials, workspaceId, relayApiKey, runId, userId, callbackUrl?, callbackToken?,
     daytonaApiKey?, s3CodeKey?, workflowConfig?)
   - StepCredentials interface (subset for step sandboxes — adds sandboxId, removes
     callbackUrl, callbackToken, daytonaApiKey, s3CodeKey)
   - buildCredentialBundle(): constructs full bundle from parts
   - buildStepCredentials(bundle, sandboxId): strips orchestrator-only fields, adds sandboxId
   - credentialsToEnv(creds: StepCredentials): converts to env var Record

2. ${LIB}/auth/s3-credentials.ts — STS credential minting
   - mintS3Credentials(options: { userId, runId, roleArn, bucket, durationSeconds? })
   - Calls STS.AssumeRole with inline session policy scoped to s3:PutObject + GetObject + multipart

3. ${LIB}/auth/cli-credentials.ts — CLI credential extraction and mounting
   - getCliCredentials(daytona, provider): returns credential JSON string
   - mountCliCredentials(sandbox, home, credentialJson): writes .claude/.credentials.json + .claude.json

## Volumes (1 file)

4. ${LIB}/volumes/manager.ts — VolumeManager
   - createVolume(name, opts?): creates volume, polls until ready
   - mountConfig(volumeId, mountPath): returns volume mount config
   - cleanup(volumeId): removes volume, handles already-deleted gracefully
   - createCodeVolume(runId): convenience

## Storage (4 files)

5. ${LIB}/storage/client.ts — ScopedS3Client wrapping @aws-sdk/client-s3
   - Auto-prefix keys with userId/runId
   - putObject, getObject, multipart operations

6. ${LIB}/storage/log-streamer.ts — Real-time log streaming to S3
   - Uses multipart for large logs, PutObject fallback for small

7. ${LIB}/storage/metadata.ts — StepMetadata + RunManifest types and writers

8. ${LIB}/storage/code-transfer.ts — Code upload/download via S3
   - uploadCode(s3Client, localDir): tars local dir, uploads to S3
   - downloadAndExtractCode(s3Client, s3Key, sandbox, targetDir): downloads tar.gz, extracts

Also design the SDK change: runner.ts getRelayEnv() must include RELAY_WORKSPACE_ID.

Write your design to /shared/p1-foundation-design.md.
          `.trim(),
          verification: { exit_code: 0 },
        },

        // Wave 1: Auth (3 parallel workers)
        {
          name: "p1-worker-credentials",
          type: "agent",
          agent: "codex-1",
          dependsOn: ["p1-lead-plan"],
          task: `
Implement the credential bundle types and helpers.
Write the file to disk at: ${LIB}/auth/credentials.ts

Read the design from /shared/p1-foundation-design.md.

Implement:
- S3Credentials interface (accessKeyId, secretAccessKey, sessionToken, bucket, prefix)
- CredentialBundle interface (s3Credentials, cliCredentials, workspaceId, relayApiKey,
  runId, userId, callbackUrl?, callbackToken?, daytonaApiKey?, s3CodeKey?, workflowConfig?)
- StepCredentials interface (adds sandboxId, removes orchestrator-only fields)
- buildCredentialBundle(): constructs full bundle from parts
- buildStepCredentials(bundle, sandboxId): strips orchestrator-only fields, adds sandboxId
- credentialsToEnv(creds: StepCredentials): converts to env var Record
  Maps: S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_SESSION_TOKEN, S3_BUCKET, S3_PREFIX,
  RELAY_WORKSPACE_ID, RELAY_API_KEY, RUN_ID, USER_ID, SANDBOX_ID

Write the file to disk. Do not just output the code — actually create the file at the path above.
          `.trim(),
          verification: { exit_code: 0 },
        },
        {
          name: "p1-worker-s3-auth",
          type: "agent",
          agent: "codex-2",
          dependsOn: ["p1-lead-plan"],
          task: `
Implement STS credential minting.
Write the file to disk at: ${LIB}/auth/s3-credentials.ts

Read the design from /shared/p1-foundation-design.md.

Implement:
- mintS3Credentials(options: { userId, runId, roleArn, bucket, durationSeconds? })
  - Calls STS.AssumeRole with RoleSessionName = "workflow-{runId}"
  - Inline session policy scopes to s3:PutObject, s3:GetObject, s3:CreateMultipartUpload,
    s3:UploadPart, s3:CompleteMultipartUpload, s3:AbortMultipartUpload
    on arn:aws:s3:::{bucket}/{userId}/{runId}/*
  - Returns S3Credentials object
- Use @aws-sdk/client-sts (standard AWS SDK v3)
- Handle STS errors with descriptive messages

Write the file to disk. Do not just output the code — actually create the file at the path above.
          `.trim(),
          verification: { exit_code: 0 },
        },
        {
          name: "p1-worker-cli-auth",
          type: "agent",
          agent: "codex-3",
          dependsOn: ["p1-lead-plan"],
          task: `
Two tasks:

1. Write the file to disk at: ${LIB}/auth/cli-credentials.ts
   Read the design from /shared/p1-foundation-design.md and the existing mountCredentials()
   method in lib/orchestrator.ts for the exact file structure.
   Implement:
   - getCliCredentials(daytona: Daytona, provider: string): Promise<string>
   - mountCliCredentials(sandbox, home: string, credentialJson: string): Promise<void>
     Writes two files to the sandbox:
     a) {home}/.claude/.credentials.json — the credential JSON
     b) {home}/.claude.json — { hasCompletedOnboarding: true, firstStartTime: <ISO date> }

2. Propagate workspace ID through the SDK:
   - ${SDK}/runner.ts — In getRelayEnv(), add RELAY_WORKSPACE_ID
   - ${RELAY}/packages/sdk/src/spawn-from-env.ts — Add RELAY_WORKSPACE_ID

Write all files to disk. Do not just output the code — actually create the files at the paths above.
          `.trim(),
          verification: { exit_code: 0 },
        },

        // File check gate: verify auth files exist
        {
          name: "p1-check-auth",
          type: "deterministic",
          dependsOn: ["p1-worker-credentials", "p1-worker-s3-auth", "p1-worker-cli-auth"],
          command: [
            `[ -f ${LIB}/auth/credentials.ts ] && echo "OK credentials.ts" || echo "MISSING credentials.ts"`,
            `[ -f ${LIB}/auth/s3-credentials.ts ] && echo "OK s3-credentials.ts" || echo "MISSING s3-credentials.ts"`,
            `[ -f ${LIB}/auth/cli-credentials.ts ] && echo "OK cli-credentials.ts" || echo "MISSING cli-credentials.ts"`,
          ].join(" && "),
          captureOutput: true,
        },

        // Wave 2: Volumes + Storage (3 parallel workers)
        {
          name: "p1-worker-volumes",
          type: "agent",
          agent: "codex-1",
          dependsOn: ["p1-check-auth"],
          task: `
Implement VolumeManager.
Write the file to disk at: ${LIB}/volumes/manager.ts

Read design from /shared/p1-foundation-design.md and Daytona SDK patterns in
${RELAY}/src/cli/lib/connect-daytona.ts.

Implement the full class with:
- createVolume(): Daytona SDK volume.create + poll until state=ready
- mountConfig(): returns { volumeId, mountPath } config object
- cleanup(): volume.delete, catch already-deleted (404/not-found)
- createCodeVolume(): creates volume with run-prefixed name
- Configurable polling (default 2s interval, 30s timeout)
- Proper TypeScript types and exports

Write the file to disk. Do not just output the code — actually create the file at the path above.
          `.trim(),
          verification: { exit_code: 0 },
        },
        {
          name: "p1-worker-storage-core",
          type: "agent",
          agent: "codex-2",
          dependsOn: ["p1-check-auth"],
          task: `
Implement two storage files. Read the auth types from ${LIB}/auth/credentials.ts first.

File 1 — write to disk at: ${LIB}/storage/client.ts
ScopedS3Client class wrapping @aws-sdk/client-s3:
- Constructor takes S3Credentials (from auth module), creates S3Client
- All key operations auto-prefix with the credential's prefix (userId/runId)
- scopedKey(parts: string[]): builds full S3 key
- putObject(key, body, contentType?)
- getObject(key): returns Buffer
- createMultipartUpload(key): returns uploadId
- uploadPart(key, uploadId, partNumber, body): returns ETag
- completeMultipartUpload(key, uploadId, parts)
- abortMultipartUpload(key, uploadId)

File 2 — write to disk at: ${LIB}/storage/metadata.ts
- StepMetadata interface: stepName, agent, preset, cli, startTime, endTime, durationMs,
  exitCode, sandboxId, outputSummary, error?
- buildMetadata(step, result): constructs StepMetadata
- writeMetadata(client, sandboxId, metadata): writes {sandboxId}/metadata.json
- RunManifest type: runId, userId, workspaceId, workflowName, startTime, status, steps[]
- writeRunManifest(client, manifest): writes manifest.json at run root

Write both files to disk. Do not just output the code — actually create the files.
          `.trim(),
          verification: { exit_code: 0 },
        },
        {
          name: "p1-worker-storage-streaming",
          type: "agent",
          agent: "codex-3",
          dependsOn: ["p1-check-auth"],
          task: `
Implement two storage files. Read design from /shared/p1-foundation-design.md.

File 1 — write to disk at: ${LIB}/storage/log-streamer.ts
LogStreamer class that streams agent stdout/stderr to S3:
- Constructor takes ScopedS3Client + sandboxId
- start(): createMultipartUpload for {sandboxId}/agent.log
- write(chunk): buffers, flushes when buffer >= 5MB
- finish(): uploads final buffer, completes multipart. Falls back to PutObject for <5MB
- abort(): aborts multipart if one was started
- Track uploaded parts array for CompleteMultipartUpload

File 2 — write to disk at: ${LIB}/storage/code-transfer.ts
Read the existing tar pattern in lib/code-sync/sync.ts for reference.
- uploadCode(s3Client, localDir): tars local dir (respects .gitignore, excludes .git/ and
  node_modules/), uploads tar.gz to S3 at "code.tar.gz", returns S3 key
- downloadAndExtractCode(s3Client, s3Key, sandbox, targetDir): downloads tar.gz from S3,
  uploads to sandbox at /tmp/code.tar.gz, extracts to targetDir, cleans up

Write both files to disk. Do not just output the code — actually create the files.
          `.trim(),
          verification: { exit_code: 0 },
        },

        // File check gate: verify all foundation files exist
        {
          name: "p1-check-all",
          type: "deterministic",
          dependsOn: ["p1-worker-volumes", "p1-worker-storage-core", "p1-worker-storage-streaming"],
          command: [
            `for f in ${LIB}/auth/credentials.ts ${LIB}/auth/s3-credentials.ts ${LIB}/auth/cli-credentials.ts ${LIB}/volumes/manager.ts ${LIB}/storage/client.ts ${LIB}/storage/log-streamer.ts ${LIB}/storage/metadata.ts ${LIB}/storage/code-transfer.ts; do`,
            `[ -f "$f" ] && echo "OK $(basename $f)" || (echo "MISSING $(basename $f)" && exit 1)`,
            `done`,
          ].join(" "),
          captureOutput: true,
        },

        // Phase 1 read + review
        {
          name: "p1-read-code",
          type: "deterministic",
          dependsOn: ["p1-check-all"],
          command: `for f in ${LIB}/auth/credentials.ts ${LIB}/auth/s3-credentials.ts ${LIB}/auth/cli-credentials.ts ${LIB}/volumes/manager.ts ${LIB}/storage/client.ts ${LIB}/storage/log-streamer.ts ${LIB}/storage/metadata.ts ${LIB}/storage/code-transfer.ts; do echo "=== $f ===" && cat "$f" 2>/dev/null || echo 'FILE NOT FOUND'; done`,
          captureOutput: true,
        },
        {
          name: "p1-review",
          type: "agent",
          agent: "lead",
          dependsOn: ["p1-read-code"],
          task: `
Phase 1 Review: Foundation (auth + volumes + storage).

Read all 8 implementations from the previous step output. Verify:
1. CredentialBundle vs StepCredentials separation is clean
2. STS inline policy includes s3:GetObject (orchestrator needs to download code tar.gz)
3. credentialsToEnv() maps all fields including RELAY_API_KEY and RELAY_WORKSPACE_ID
4. mountCliCredentials writes BOTH .credentials.json AND .claude.json (onboarding bypass)
5. VolumeManager polling has proper timeout with descriptive error
6. ScopedS3Client auto-prefixes keys correctly
7. LogStreamer falls back to PutObject for <5MB logs
8. code-transfer downloadAndExtractCode cleans up /tmp/code.tar.gz after extraction
9. No secrets accidentally logged or exposed

${PHASE_REVIEW}
          `.trim(),
          verification: { exit_code: 0 },
        },

        // ═══════════════════════════════════════════════════════════════
        // Phase 2: Orchestration
        // Creates: lib/executor/executor.ts
        //          lib/executor/presets.ts
        //          lib/bootstrap/script-generator.ts
        //          lib/bootstrap/launcher.ts
        // ═══════════════════════════════════════════════════════════════

        {
          name: "p2-read-context",
          type: "deterministic",
          dependsOn: ["p1-review"],
          command: [
            `cat ${SDK}/runner.ts | head -200`,
            `echo '---SEPARATOR---'`,
            `cat ${SDK}/types.ts | head -300`,
            `echo '---SEPARATOR---'`,
            `cat lib/orchestrator.ts | head -200`,
            `echo '---SEPARATOR---'`,
            `cat ${LIB}/auth/credentials.ts 2>/dev/null | head -80`,
            `echo '---SEPARATOR---'`,
            `cat ${LIB}/storage/metadata.ts 2>/dev/null | head -60`,
          ].join(" && "),
          captureOutput: true,
        },
        {
          name: "p2-lead-plan",
          type: "agent",
          agent: "lead",
          dependsOn: ["p2-read-context"],
          task: `
Design ALL orchestration modules. Read the StepExecutor interface, types, and
existing orchestrator patterns from the previous step.

Four files to design:

1. ${LIB}/executor/executor.ts — DaytonaStepExecutor
   Implements the StepExecutor interface from runner.ts. For each step creates an
   isolated Daytona sandbox. Wires together Phase 1 modules:
   - Constructor takes options: { daytona, credentials: CredentialBundle,
     volumeManager, s3: ScopedS3Client, codeVolumeMountPath? }
   - executeAgentStep: create sandbox → mount code volume → mount CLI creds as files →
     inject S3 env vars → start LogStreamer → run agent → finish/abort log → write metadata → cleanup
   - executeDeterministicStep: create sandbox → mount code volume → run command → capture output → cleanup

2. ${LIB}/executor/presets.ts — CLI preset flag mapping
   - getPresetFlags(cli, preset): returns { args, env? }
   - buildAgentCommand(cli, preset, task, agentName): returns full command string

3. ${LIB}/bootstrap/script-generator.ts — generateBootstrapScript(config)
   Returns a self-contained Node.js script that runs inside the orchestrator sandbox:
   - Downloads code.tar.gz from S3, extracts to code volume
   - Starts broker, creates StepExecutor, runs WorkflowRunner
   - Reports completion/error to callback URL via Reporter
   - Supports yaml/ts/py file types

4. ${LIB}/bootstrap/launcher.ts — launchOrchestratorSandbox(options)
   Creates sandbox, installs deps + SDK, sets env vars, generates and uploads
   bootstrap script, starts it.

Write design to /shared/p2-orchestration-design.md.
          `.trim(),
          verification: { exit_code: 0 },
        },

        // Wave 1: executor + presets (2 workers), launcher (1 worker)
        {
          name: "p2-worker-executor",
          type: "agent",
          agent: "codex-1",
          dependsOn: ["p2-lead-plan"],
          task: `
Implement DaytonaStepExecutor.
Write the file to disk at: ${LIB}/executor/executor.ts

Read the design from /shared/p2-orchestration-design.md.
Read the StepExecutor interface from ${SDK}/types.ts.
Read the auth types from ${LIB}/auth/credentials.ts.

Implement:
- DaytonaStepExecutorOptions interface: { daytona, credentials, volumeManager, s3, codeVolumeMountPath? }
- Constructor takes DaytonaStepExecutorOptions (single options object)
- executeAgentStep(step, agentDef):
  - Create sandbox with code volume mount via volumeManager.mountConfig()
  - Mount CLI credentials as files via mountCliCredentials()
  - Inject S3 + workspace env vars via credentialsToEnv(buildStepCredentials(bundle, sandbox.id))
  - Get CLI flags from presets via getPresetFlags()
  - Start LogStreamer, run agent command, finish/abort log, write metadata
  - Cleanup sandbox in finally block
- executeDeterministicStep(step):
  - Create sandbox with code volume, run command, capture output, cleanup in finally
- Conforms to StepExecutor interface — use step.name (not step.id)

Import from:
- '@relayflows/core' for types (WorkflowStep, AgentDefinition, StepExecutor)
- '../auth/credentials.js' for buildStepCredentials, credentialsToEnv, CredentialBundle
- '../auth/cli-credentials.js' for mountCliCredentials
- '../volumes/manager.js' for VolumeManager
- '../storage/client.js' for ScopedS3Client
- '../storage/log-streamer.js' for LogStreamer
- '../storage/metadata.js' for buildMetadata, writeMetadata
- './presets.js' for getPresetFlags, buildAgentCommand

Write the file to disk. Do not just output the code — actually create the file at the path above.
          `.trim(),
          verification: { exit_code: 0 },
        },
        {
          name: "p2-worker-presets",
          type: "agent",
          agent: "codex-2",
          dependsOn: ["p2-lead-plan"],
          task: `
Implement CLI preset flag mapping.
Write the file to disk at: ${LIB}/executor/presets.ts

Read the design from /shared/p2-orchestration-design.md.
Read AgentCli and AgentPreset types from ${SDK}/types.ts.

Implement:
- Import AgentCli, AgentPreset from '@relayflows/core'
- PresetFlags type: { args: string[], env?: Record<string, string> }
- getPresetFlags(cli: AgentCli, preset: AgentPreset): PresetFlags
  Mapping:
  - claude + lead: interactive PTY mode, relay-aware
  - claude + worker: --print flag, structured output
  - claude + reviewer: --print flag, analysis mode
  - claude + analyst: --print flag, read-only analysis
  - codex + worker: appropriate non-interactive flags
  - codex + reviewer: review flags
  - codex + analyst: analysis flags
- buildAgentCommand(cli, preset, task, agentName): returns full command string

Write the file to disk. Do not just output the code — actually create the file at the path above.
          `.trim(),
          verification: { exit_code: 0 },
        },
        {
          name: "p2-worker-bootstrap",
          type: "agent",
          agent: "codex-3",
          dependsOn: ["p2-lead-plan"],
          task: `
Implement the bootstrap module (2 files).

File 1 — write to disk at: ${LIB}/bootstrap/script-generator.ts
Read the design from /shared/p2-orchestration-design.md.

generateBootstrapScript(config: { fileType, workflowConfig?, workflowFile?, codeMountPath? }):
Returns a self-contained Node.js script string (ES module) that:
- Reads env vars: CALLBACK_URL, CALLBACK_TOKEN, RUN_ID, USER_ID, RELAY_WORKSPACE_ID,
  S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_SESSION_TOKEN, S3_BUCKET, S3_PREFIX,
  S3_CODE_KEY, DAYTONA_API_KEY, RELAY_API_KEY, WORKFLOW_CONFIG, WORKFLOW_FILE
- Creates ScopedS3Client from S3 env vars
- Downloads code.tar.gz from S3 via downloadAndExtractCode() into codeMountPath
- Starts broker process
- Creates VolumeManager, DaytonaStepExecutor (using options object constructor)
- Creates Reporter from CALLBACK_URL + CALLBACK_TOKEN (options object constructor)
- Writes initial RunManifest (fields: runId, userId, workspaceId, workflowName, startTime, status, steps)
- Executes workflow based on fileType: yaml→WorkflowRunner.execute(config), ts→npx tsx, py→python3
- Reports completion/error via Reporter
- Updates RunManifest with final status

File 2 — write to disk at: ${LIB}/bootstrap/launcher.ts
Read lib/orchestrator.ts for the sandbox creation + SDK upload pattern.

launchOrchestratorSandbox(options: LaunchOptions): Promise<LaunchResult>
- Import CredentialBundle from '../auth/credentials.js' (do NOT duplicate the type)
- Creates Daytona sandbox, creates code volume via VolumeManager
- Installs deps, uploads SDK tarball
- Sets env vars from CredentialBundle via local credentialsToEnv helper
  (this version takes CredentialBundle, not StepCredentials)
- Generates bootstrap script, uploads to sandbox, starts via nohup
- Returns { sandboxId, runId }

Write both files to disk. Do not just output the code — actually create the files at the paths above.
          `.trim(),
          verification: { exit_code: 0 },
        },

        // File check gate: verify orchestration files exist
        {
          name: "p2-check-all",
          type: "deterministic",
          dependsOn: ["p2-worker-executor", "p2-worker-presets", "p2-worker-bootstrap"],
          command: [
            `for f in ${LIB}/executor/executor.ts ${LIB}/executor/presets.ts ${LIB}/bootstrap/script-generator.ts ${LIB}/bootstrap/launcher.ts; do`,
            `[ -f "$f" ] && echo "OK $(basename $f)" || (echo "MISSING $(basename $f)" && exit 1)`,
            `done`,
          ].join(" "),
          captureOutput: true,
        },

        // Phase 2 read + review
        {
          name: "p2-read-code",
          type: "deterministic",
          dependsOn: ["p2-check-all"],
          command: `for f in ${LIB}/executor/executor.ts ${LIB}/executor/presets.ts ${LIB}/bootstrap/script-generator.ts ${LIB}/bootstrap/launcher.ts; do echo "=== $f ===" && cat "$f" 2>/dev/null || echo 'FILE NOT FOUND'; done`,
          captureOutput: true,
        },
        {
          name: "p2-review",
          type: "agent",
          agent: "lead",
          dependsOn: ["p2-read-code"],
          task: `
Phase 2 Review: Orchestration (executor + bootstrap).

Read all 4 implementations from the previous step output. Verify:
1. DaytonaStepExecutor conforms to StepExecutor interface from runner.ts
2. Uses step.name (not step.id) — WorkflowStep has name, not id
3. Constructor takes options object (not positional args)
4. CLI credentials are mounted as FILES (not env vars)
5. S3 credentials are injected as ENV VARS
6. LogStreamer started before agent, finished/aborted after
7. Cleanup in finally block
8. Bootstrap script downloads code BEFORE starting workflow
9. Bootstrap creates Reporter with options object constructor
10. Launcher imports CredentialBundle from auth/credentials.js (no duplicate types)
11. All imports use .js extensions for local modules
12. SDK imports use '@relayflows/core' (not subpaths)

${PHASE_REVIEW}
          `.trim(),
          verification: { exit_code: 0 },
        },

        // ═══════════════════════════════════════════════════════════════
        // Phase 3: API + Integration
        // Creates: web/app/api/v1/workflows/run/route.ts
        //          web/app/api/v1/workflows/callback/route.ts
        //          web/app/api/v1/workflows/runs/[runId]/route.ts
        //          web/lib/workflow-store.ts
        //          web/lib/workflow-client.ts
        //          web/lib/workflows.ts (re-exports)
        //          lib/reporter/reporter.ts
        //          lib/cloud-index.ts (barrel)
        // ═══════════════════════════════════════════════════════════════

        {
          name: "p3-read-context",
          type: "deterministic",
          dependsOn: ["p2-review"],
          command: [
            `find ${WEB}/app/api -name 'route.ts' -type f 2>/dev/null | head -5`,
            `echo '---SEPARATOR---'`,
            `cat ${WEB}/package.json 2>/dev/null | head -30 || echo 'NO WEB PACKAGE'`,
            `echo '---SEPARATOR---'`,
            `cat ${LIB}/auth/credentials.ts 2>/dev/null | head -40`,
            `echo '---SEPARATOR---'`,
            `cat ${LIB}/bootstrap/launcher.ts 2>/dev/null | head -40`,
          ].join(" && "),
          captureOutput: true,
        },
        {
          name: "p3-lead-plan",
          type: "agent",
          agent: "lead",
          dependsOn: ["p3-read-context"],
          task: `
Design ALL API, reporter, and integration modules.

Eight files to design:

## Reporter (1 file)

1. ${LIB}/reporter/reporter.ts — Reporter
   - Constructor takes options: { callbackUrl, callbackToken }
   - reportCompletion(runId, result): POSTs to callback URL with status "completed"
   - reportError(runId, error): POSTs to callback URL with status "failed"
   - Private post() with retry (3 attempts, exponential backoff)

## Barrel Export (1 file)

2. ${LIB}/cloud-index.ts — Re-exports everything from all submodules
   Use .js extensions on all import paths.
   Be careful: s3-credentials.ts and credentials.ts both export an S3Credentials type.
   Use selective re-export from s3-credentials to avoid collision.

## Web Layer (6 files)

3. ${WEB}/lib/workflow-store.ts — In-memory Map store
   - WorkflowRecord type, create/get/update methods

4. ${WEB}/lib/workflows.ts — Re-exports from real implementations
   Import from ../../lib/auth/s3-credentials.js, ../../lib/bootstrap/launcher.js,
   ../../lib/auth/credentials.js — do NOT create stub implementations.

5. ${WEB}/lib/workflow-client.ts — CLI helper
   - postWorkflow(options): POST to /api/v1/workflows/run
   - uploadCodeAndRun(options): uploads code to S3 then calls postWorkflow

6. ${WEB}/app/api/v1/workflows/run/route.ts — POST
   Validates JWT, mints S3 creds, builds CredentialBundle, launches sandbox.
   Map fileType: ts→typescript, py→python (the SDK uses full names).

7. ${WEB}/app/api/v1/workflows/runs/[runId]/route.ts — GET status

8. ${WEB}/app/api/v1/workflows/callback/route.ts — POST callback

Write design to /shared/p3-api-design.md.
          `.trim(),
          verification: { exit_code: 0 },
        },

        // Wave 1: reporter + barrel + web helpers (3 parallel workers)
        {
          name: "p3-worker-reporter",
          type: "agent",
          agent: "codex-1",
          dependsOn: ["p3-lead-plan"],
          task: `
Implement two files.

File 1 — write to disk at: ${LIB}/reporter/reporter.ts
Read design from /shared/p3-api-design.md.
- ReporterOptions interface: { callbackUrl: string, callbackToken: string }
- Reporter class with constructor({ callbackUrl, callbackToken }: ReporterOptions)
- reportCompletion(runId, result): POST JSON { runId, callbackToken, status: "completed", result }
- reportError(runId, error): POST JSON { runId, callbackToken, status: "failed", error: message }
- Private post() with retry (3 attempts, 1s/2s/4s exponential backoff)
- Uses native fetch()

File 2 — write to disk at: ${LIB}/cloud-index.ts
Barrel export re-exporting from all submodules with .js extensions:
- export * from './auth/credentials.js'
- export { mintS3Credentials, type MintS3CredentialsOptions } from './auth/s3-credentials.js'
  (selective to avoid S3Credentials name collision with credentials.ts)
- export * from './auth/cli-credentials.js'
- export * from './volumes/manager.js'
- export * from './storage/client.js'
- export * from './storage/log-streamer.js'
- export * from './storage/metadata.js'
- export * from './storage/code-transfer.js'
- export * from './executor/executor.js'
- export * from './executor/presets.js'
- export * from './bootstrap/script-generator.js'
- export * from './bootstrap/launcher.js'
- export * from './reporter/reporter.js'

Write both files to disk. Do not just output the code — actually create the files.
          `.trim(),
          verification: { exit_code: 0 },
        },
        {
          name: "p3-worker-web-helpers",
          type: "agent",
          agent: "codex-2",
          dependsOn: ["p3-lead-plan"],
          task: `
Implement three web helper files.

File 1 — write to disk at: ${WEB}/lib/workflow-store.ts
In-memory Map store:
- WorkflowRecord type (runId, sandboxId, userId, workspaceId, workflow, fileType, status,
  callbackToken, createdAt, updatedAt, result?, error?)
- workflowStore singleton with: create(input), get(runId), update(runId, patch)

File 2 — write to disk at: ${WEB}/lib/workflows.ts
Re-exports from real implementations (NOT stubs):
- import { mintS3Credentials, type MintS3CredentialsOptions } from "../../lib/auth/s3-credentials.js"
- import { launchOrchestratorSandbox, type LaunchOptions, type LaunchResult } from "../../lib/bootstrap/launcher.js"
- import { buildCredentialBundle, type CredentialBundle } from "../../lib/auth/credentials.js"
- Re-export all imports plus the types

File 3 — write to disk at: ${WEB}/lib/workflow-client.ts
CLI helper:
- WorkflowClientError class extending Error with statusCode
- postWorkflow(options: { apiUrl, jwt, workflow, fileType }): POST to /api/v1/workflows/run
- uploadCodeAndRun(options): uploads code to S3 then calls postWorkflow
- Import uploadCode from '../../lib/storage/code-transfer.js'
- Import ScopedS3Client from '../../lib/storage/client.js'

Write all files to disk. Do not just output the code — actually create the files.
          `.trim(),
          verification: { exit_code: 0 },
        },
        {
          name: "p3-worker-routes",
          type: "agent",
          agent: "codex-3",
          dependsOn: ["p3-lead-plan"],
          task: `
Implement three Next.js API routes. Follow Next.js 14+ app router conventions.

File 1 — write to disk at: ${WEB}/app/api/v1/workflows/run/route.ts
POST handler:
- Parse Authorization header JWT → extract userId, workspaceId (TODO: verify JWT signature)
- Parse body: { workflow, fileType }
- normalizeFileType: ts→typescript, py→python, yaml→yaml
- Generate runId (crypto.randomUUID), callbackToken (crypto.randomUUID)
- Mint S3 credentials via mintS3Credentials()
- Build CredentialBundle via buildCredentialBundle()
- Call launchOrchestratorSandbox()
- Store via workflowStore.create()
- Return NextResponse.json({ runId, sandboxId, status: "pending" })
- Import from '@/lib/workflows' (which re-exports real implementations)

File 2 — write to disk at: ${WEB}/app/api/v1/workflows/runs/[runId]/route.ts
GET handler: fetch from workflowStore, return 404 if not found

File 3 — write to disk at: ${WEB}/app/api/v1/workflows/callback/route.ts
POST handler:
- Parse body: { runId, callbackToken, status, result?, error? }
- Validate callbackToken matches store
- Update store accordingly
- Return 200 on success, 401 bad token, 404 unknown runId

Write all files to disk. Do not just output the code — actually create the files at the paths above.
          `.trim(),
          verification: { exit_code: 0 },
        },

        // File check gate: verify all Phase 3 files exist
        {
          name: "p3-check-all",
          type: "deterministic",
          dependsOn: ["p3-worker-reporter", "p3-worker-web-helpers", "p3-worker-routes"],
          command: [
            `for f in ${LIB}/reporter/reporter.ts ${LIB}/cloud-index.ts ${WEB}/lib/workflow-store.ts ${WEB}/lib/workflows.ts ${WEB}/lib/workflow-client.ts ${WEB}/app/api/v1/workflows/run/route.ts ${WEB}/app/api/v1/workflows/callback/route.ts; do`,
            `[ -f "$f" ] && echo "OK $(basename $f)" || (echo "MISSING $(basename $f)" && exit 1)`,
            `done`,
          ].join(" "),
          captureOutput: true,
        },

        // Phase 3 read + review
        {
          name: "p3-read-code",
          type: "deterministic",
          dependsOn: ["p3-check-all"],
          command: `for f in ${LIB}/reporter/reporter.ts ${LIB}/cloud-index.ts ${WEB}/lib/workflows.ts ${WEB}/lib/workflow-client.ts ${WEB}/app/api/v1/workflows/run/route.ts ${WEB}/app/api/v1/workflows/callback/route.ts; do echo "=== $f ===" && cat "$f" 2>/dev/null || echo 'FILE NOT FOUND'; done`,
          captureOutput: true,
        },
        {
          name: "p3-review",
          type: "agent",
          agent: "lead",
          dependsOn: ["p3-read-code"],
          task: `
Phase 3 Review: API + Integration.

Read all implementations from the previous step output. Verify:
1. Reporter constructor takes options object { callbackUrl, callbackToken }
2. Barrel export uses .js extensions and selective s3-credentials re-export
3. web/lib/workflows.ts imports from real modules (not stubs)
4. workflow-client.ts imports from relative paths (not @relay/sdk)
5. Run route normalizes fileType (ts→typescript, py→python)
6. Run route builds CredentialBundle using buildCredentialBundle()
7. Callback route validates callbackToken
8. All imports resolve correctly
9. No circular dependencies
10. No secrets in response bodies

Also verify the complete end-to-end chain:
CLI → uploadCodeAndRun → POST /run → mint S3 creds → launch sandbox →
bootstrap downloads code → runs workflow → Reporter POSTs callback →
callback route updates store → GET /runs returns status

${PHASE_REVIEW}
          `.trim(),
          verification: { exit_code: 0 },
        },
      ],
    },
  ],
  errorHandling: { strategy: "continue" },
};

// Run directly when executed as a script
const isMain =
  process.argv[1]?.endsWith("cloud-orchestration.ts") ||
  process.argv[1]?.endsWith("cloud-orchestration.js");

if (isMain) {
  const run = async () => {
    const db = new InMemoryWorkflowDb();
    const runner = new WorkflowRunner({ db });
    runner.on((event) => {
      const prefix = event.type.startsWith("run:") ? "[run]" : "[step]";
      const name = "stepName" in event ? ` ${event.stepName}` : "";
      const status = event.type.split(":")[1];
      console.log(`${prefix}${name} ${status}`);
    });

    const result = await runner.execute(config);
    console.log(`\nWorkflow ${result.status} (${result.id})`);
    if (result.status === "failed") {
      console.error(result.error);
      process.exit(1);
    }
  };
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
