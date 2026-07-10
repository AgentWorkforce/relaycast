/**
 * Fast Workspace Seeding — dag pattern with lead + workers.
 *
 * Implements two complementary strategies to eliminate the slow file-by-file
 * upload that makes `relay on` and workflow runs hang on large projects:
 *
 * Option 3: Local symlink mount — for single-machine use. Creates a symlink
 *   tree instead of uploading to relayfile, giving instant "mount" with the
 *   same .agentignore / .agentreadonly enforcement.
 *
 * Option 2: Tar-based bulk upload — for distributed/cloud use. Replaces the
 *   JSON-per-file batch upload with a single gzipped tarball (reusing the
 *   proven createTarball() path from `agent-relay run --cloud`).
 *
 * Repos touched:
 *   - relay (AgentWorkforce/relay) — CLI `on` command, provisioner, seeder
 *   - cloud (AgentWorkforce/cloud) — relayfile worker tar import endpoint
 *
 * Agents:
 *   - claude (lead): architecture, code review, integration design
 *   - codex (workers): heavy implementation across both repos
 */

import { workflow } from "@relayflows/core";
import { Models } from "@agent-relay/sdk";

const result = await workflow("fast-workspace-seeding")
    .description(
      "Replace slow file-by-file workspace seeding with local symlink mount (option 3) and tar-based bulk upload (option 2)"
    )
    .pattern("dag")
    .channel("wf-fast-seeding")
    .maxConcurrency(5)
    .timeout(3_600_000)

    // ── Agents ────────────────────────────────────────────────────────
    .agent("lead", {
      cli: "claude",
      role: "Architect — designs interfaces, reviews implementations, integrates across repos",
      retries: 2,
    })
    .agent("symlink-worker", {
      cli: "opencode",
      model: "opencode/gpt-5.4",
      role: "Implements the local symlink mount module in relay repo",
      preset: "worker",
      retries: 2,
    })
    .agent("tar-worker", {
      cli: "opencode",
      model: "opencode/gpt-5.4",
      role: "Implements tar-based bulk upload in relay repo seeder",
      preset: "worker",
      retries: 2,
    })
    .agent("endpoint-worker", {
      cli: "opencode",
      model: "opencode/gpt-5.4",
      role: "Implements the relayfile tar import endpoint in cloud repo",
      preset: "worker",
      retries: 2,
    })
    .agent("cli-worker", {
      cli: "opencode",
      model: "opencode/gpt-5.4",
      role: "Wires new strategies into relay on CLI and provisioner",
      preset: "worker",
      retries: 2,
    })
    .agent("test-worker", {
      cli: "opencode",
      model: "opencode/gpt-5.4",
      role: "Writes tests for all new modules",
      preset: "worker",
      retries: 2,
    })
    .agent("reviewer", {
      cli: "opencode",
      model: "opencode/gpt-5.4",
      role: "Peer reviewer — reads implementations and flags issues",
      preset: "reviewer",
      retries: 1,
    })

    // ══════════════════════════════════════════════════════════════════
    // Phase 1: Architecture & Interface Design (lead only)
    // ══════════════════════════════════════════════════════════════════

    .step("architecture", {
      agent: "lead",
      task: `You are designing two fast-path strategies for workspace seeding in the agent-relay system. Read these files to understand the current implementation:

RELAY REPO (../relay):
- src/cli/commands/on/start.ts — the goOnTheRelay() function, especially seedWorkspaceFiles() call at ~line 1250 and the relayfile-mount flow
- src/cli/commands/on/workspace.ts — seedWorkspace(), collectSeedPaths(), postBulkWrite()
- packages/sdk/src/provisioner/index.ts — provisionWorkflowAgents() with skipSeeding/skipMount flags
- packages/sdk/src/provisioner/seeder.ts — the shared seeder used by both CLI and workflow runner
- packages/cloud/src/workflows.ts — createTarball() function that already uses tar+gzip for --cloud uploads

CLOUD REPO (.):
- packages/web/app/api/v1/workspaces/create/route.ts and the parent route.ts — workspace creation
- packages/web/app/api/v1/workspaces/[workspaceId]/join/route.ts — workspace join

Produce an architecture document that defines:

1. SYMLINK MOUNT MODULE (relay repo: src/cli/commands/on/symlink-mount.ts)
   - Function signature: createSymlinkMount(projectDir, mountDir, options) => CleanupHandle
   - How it walks projectDir respecting .agentignore (skip), .agentreadonly (copy + chmod 444), writable (copy with normal perms)
   - CleanupHandle interface: { mountDir, syncBack(), cleanup() }
   - syncBack() copies modified writable files from mountDir back to projectDir (reuse existing syncWritableFilesBack logic)

2. TAR BULK UPLOAD (relay repo: packages/sdk/src/provisioner/seeder.ts)
   - New function: seedWorkspaceTar(baseUrl, token, workspaceId, projectDir, excludeDirs) => number
   - Reuses createTarball() approach: git ls-files, tar+gzip, single POST
   - Falls back to current batch upload if tar endpoint returns 404 (backwards compat)

3. TAR IMPORT ENDPOINT (cloud repo: relayfile worker or cloud API)
   - POST /v1/workspaces/{id}/fs/import accepting application/gzip body
   - Extracts tar.gz into workspace storage
   - Returns { imported: number }

4. CLI INTEGRATION (relay repo: src/cli/commands/on/start.ts)
   - Decision logic in goOnTheRelay(): if portAuth/portFile are remote AND no --local flag => tar upload path. If local or --local flag => symlink mount path.
   - Skip relayfile-mount binary download for symlink path

5. PROVISIONER INTEGRATION (relay repo: packages/sdk/src/provisioner/index.ts)
   - Wire seedWorkspaceTar as the default seeder, with fallback to batch

Write the architecture to a file at /tmp/fast-seeding-architecture.md. Include exact function signatures, file paths, and the interface contracts between modules.`,
      verification: { type: "file_exists", value: "/tmp/fast-seeding-architecture.md" },
    })

    .step("read-architecture", {
      type: "deterministic",
      command: "cat /tmp/fast-seeding-architecture.md",
      dependsOn: ["architecture"],
      captureOutput: true,
    })

    // ══════════════════════════════════════════════════════════════════
    // Phase 2: Parallel Implementation (codex workers)
    // ══════════════════════════════════════════════════════════════════

    // ── Option 3: Symlink mount module ───────────────────────────────
    .step("impl-symlink-mount", {
      agent: "symlink-worker",
      task: `Implement the local symlink mount module based on this architecture:
{{steps.read-architecture.output}}

Create the file: src/cli/commands/on/symlink-mount.ts in the relay repo at ../relay

The module must:
1. Export createSymlinkMount(projectDir: string, mountDir: string, options: SymlinkMountOptions): SymlinkMountHandle
2. Walk projectDir recursively, respecting excludeDirs (default: .git, node_modules, .relay)
3. For files matching ignoredPatterns (from .agentignore): skip entirely
4. For files matching readonlyPatterns (from .agentreadonly): copy file to mountDir, chmod 444
5. For all other files (writable): copy file to mountDir with normal permissions
6. Create directory structure in mountDir mirroring projectDir
7. Write _PERMISSIONS.md into mountDir root
8. SymlinkMountHandle interface: { mountDir: string, syncBack: () => Promise<number>, cleanup: () => void }
9. syncBack() should copy modified writable files from mountDir back to projectDir (skip readonly, skip ignored, skip unchanged via content comparison)
10. cleanup() should rm -rf mountDir

Read the existing code at ../relay/src/cli/commands/on/start.ts to reuse:
- collectPermissionPatternsFromDotfiles() pattern
- syncWritableFilesBack() logic
- buildPermissionDoc() for _PERMISSIONS.md
- isPathIgnored() and globMatch() for pattern matching
- hasSameContent() for skipping unchanged files

IMPORTANT: Write the file to disk at ../relay/src/cli/commands/on/symlink-mount.ts. Do NOT output to stdout.`,
      dependsOn: ["read-architecture"],
      verification: {
        type: "file_exists",
        value: "../relay/src/cli/commands/on/symlink-mount.ts",
      },
    })

    // ── Option 2: Tar-based seeder ───────────────────────────────────
    .step("impl-tar-seeder", {
      agent: "tar-worker",
      task: `Implement tar-based bulk seeding based on this architecture:
{{steps.read-architecture.output}}

Modify the file: packages/sdk/src/provisioner/seeder.ts in the relay repo at ../relay

Add a new exported function seedWorkspaceTar() alongside the existing seedWorkspace(). Do NOT remove existing functions — this is additive.

The function must:
1. Signature: seedWorkspaceTar(baseUrl: string, token: string, workspaceId: string, projectDir: string, excludeDirs: string[]): Promise<number>
2. Use git ls-files to get file list (like createTarball in ../relay/packages/cloud/src/workflows.ts)
3. If not a git repo, fall back to walking the directory with excludeDirs filter
4. Create a tar.gz stream using the tar npm package (already a dependency)
5. POST the gzipped tarball to: POST {baseUrl}/v1/workspaces/{workspaceId}/fs/import with Content-Type: application/gzip and Authorization: Bearer {token}
6. If the endpoint returns 404 (not supported), fall back to the existing seedWorkspace() batch upload
7. Return the number of files imported
8. Include proper error handling — if tar upload fails for non-404 reasons, throw with a clear message

Read ../relay/packages/cloud/src/workflows.ts for the existing createTarball() implementation to reuse.
Read ../relay/packages/sdk/src/provisioner/seeder.ts for the existing seeder to understand the interface.

IMPORTANT: Write the changes to disk. Do NOT output file contents to stdout.`,
      dependsOn: ["read-architecture"],
      verification: { type: "exit_code" },
    })

    // ── Tar import endpoint in cloud repo ────────────────────────────
    .step("impl-tar-endpoint", {
      agent: "endpoint-worker",
      task: `Implement the relayfile tar import endpoint based on this architecture:
{{steps.read-architecture.output}}

This endpoint goes in the cloud repo (current directory).

1. Create the route file at: packages/web/app/api/v1/workspaces/[workspaceId]/fs/import/route.ts
2. Export an async POST handler that:
   a. Validates the workspaceId parameter
   b. Reads the request body as a gzipped tar stream (Content-Type: application/gzip)
   c. Extracts the tar.gz contents
   d. Writes each extracted file to the workspace's relayfile storage using the existing workspace registry / relayfile client
   e. Returns JSON: { imported: number } with status 200
3. Handle errors: invalid tar, workspace not found (404), oversized payload (413 with 500MB limit)
4. Use the existing auth pattern from the sibling route files — check resolveRequestAuth but allow anonymous access (same pattern as the workspace create endpoint)

Read these files for reference:
- packages/web/app/api/v1/workspaces/[workspaceId]/join/route.ts — auth pattern and workspace lookup
- packages/web/lib/workspace-registry.ts — how to interact with relayfile storage
- packages/web/app/api/v1/workspaces/route.ts — anonymous access pattern

IMPORTANT: Write the file to disk. Do NOT output to stdout.`,
      dependsOn: ["read-architecture"],
      verification: {
        type: "file_exists",
        value: "packages/web/app/api/v1/workspaces/[workspaceId]/fs/import/route.ts",
      },
    })

    // ══════════════════════════════════════════════════════════════════
    // Phase 2.5: Verify all implementation files exist
    // ══════════════════════════════════════════════════════════════════

    .step("verify-impl-files", {
      type: "deterministic",
      command: [
        'missing=0',
        'for f in "../relay/src/cli/commands/on/symlink-mount.ts" "packages/web/app/api/v1/workspaces/[workspaceId]/fs/import/route.ts"; do',
        '  if [ ! -f "$f" ]; then echo "MISSING: $f"; missing=$((missing+1)); fi',
        'done',
        'if [ $missing -gt 0 ]; then echo "$missing files missing"; exit 1; fi',
        'echo "All implementation files present"',
      ].join("\n"),
      dependsOn: [
        "impl-symlink-mount",
        "impl-tar-seeder",
        "impl-tar-endpoint",
      ],
      failOnError: true,
    })

    // ══════════════════════════════════════════════════════════════════
    // Phase 3: CLI & Provisioner Integration (after impl verified)
    // ══════════════════════════════════════════════════════════════════

    .step("impl-cli-integration", {
      agent: "cli-worker",
      task: `Wire the new symlink mount and tar seeder into the relay on CLI and provisioner based on this architecture:
{{steps.read-architecture.output}}

Make changes in the relay repo at ../relay. Two files to modify:

FILE 1: src/cli/commands/on/start.ts — goOnTheRelay() function
- Import createSymlinkMount from ./symlink-mount.ts
- Add decision logic after resolveConfig() and before the current seedWorkspaceFiles call:
  - If isLocalBaseUrl(authBase) OR the user passed a new --local flag: use symlink mount path
  - Otherwise: use the existing relayfile path (but with tar upload — see below)
- For the SYMLINK PATH:
  - Skip ensureRelayfileMountBinary() entirely
  - Skip seedWorkspaceFiles() and the relayfile-mount process
  - Call createSymlinkMount(projectDir, mountDir, { readonlyPatterns, ignoredPatterns })
  - Use the returned handle for cleanup (syncBack + cleanup on exit)
  - Still create the workspace session (for relaycast messaging) but skip file operations
- For the REMOTE PATH:
  - Replace the seedWorkspaceFiles import with seedWorkspaceTar from the provisioner seeder
  - Keep the existing relayfile-mount sync as fallback

FILE 2: packages/sdk/src/provisioner/index.ts — provisionWorkflowAgents()
- Import seedWorkspaceTar from ./seeder.ts
- In the seeding block (around line 211), try seedWorkspaceTar first, fall back to seedWorkspace on failure
- This makes workflow runs automatically use tar upload when the endpoint is available

Read the existing files carefully before making changes. Preserve all existing functionality.

IMPORTANT: Write changes to disk. Do NOT output file contents to stdout.`,
      dependsOn: ["verify-impl-files"],
      verification: { type: "exit_code" },
    })

    // ── Add --local flag to CLI command registration ─────────────────
    .step("impl-cli-flag", {
      agent: "cli-worker",
      task: `Add the --local flag to the on command registration in the relay repo at ../relay.

Modify: src/cli/commands/on.ts

Add a new option to the on command:
  .option('--local', 'Use local symlink mount instead of relayfile (faster, no network)')

This flag should be passed through to goOnTheRelay() via the options object.

Read the file first, then make the minimal change.

IMPORTANT: Write changes to disk.`,
      dependsOn: ["verify-impl-files"],
      verification: { type: "exit_code" },
    })

    // ══════════════════════════════════════════════════════════════════
    // Phase 4: Self-Review by Workers
    // ══════════════════════════════════════════════════════════════════

    .step("self-review-symlink", {
      agent: "symlink-worker",
      task: `Review your own implementation at ../relay/src/cli/commands/on/symlink-mount.ts.

Check for:
1. Path traversal safety — resolved paths must stay within projectDir and mountDir
2. Symlink safety — realpathSync before copying to prevent symlink-based exfiltration
3. .agentignore patterns correctly skip files (not just directories)
4. .agentreadonly files are copied AND chmod 444 (not symlinked)
5. syncBack() skips readonly and ignored files, checks content equality before copying
6. cleanup() handles the case where mountDir doesn't exist or is partially created
7. No unused imports or dead code

Fix any issues you find.`,
      dependsOn: ["impl-cli-integration"],
      verification: { type: "exit_code" },
    })

    .step("self-review-tar", {
      agent: "tar-worker",
      task: `Review your own changes to ../relay/packages/sdk/src/provisioner/seeder.ts.

Check for:
1. seedWorkspaceTar correctly falls back to seedWorkspace on 404
2. tar.create is called with gzip: true and portable: true
3. The POST to /fs/import includes correct Authorization header
4. Error messages are clear and actionable
5. The git ls-files fallback works for non-git directories
6. No breaking changes to existing exported functions

Fix any issues you find.`,
      dependsOn: ["impl-cli-integration"],
      verification: { type: "exit_code" },
    })

    .step("self-review-endpoint", {
      agent: "endpoint-worker",
      task: `Review your own implementation at packages/web/app/api/v1/workspaces/[workspaceId]/fs/import/route.ts.

Check for:
1. Auth pattern matches sibling routes (anonymous allowed, bad creds rejected)
2. Tar extraction handles nested directories correctly
3. Files are written to the correct workspace storage path
4. 413 response for oversized payloads (check Content-Length header)
5. Invalid tar data returns 400, not 500
6. No path traversal in tar entries (reject entries with ../)
7. Workspace existence is verified before extraction

Fix any issues you find.`,
      dependsOn: ["impl-cli-integration"],
      verification: { type: "exit_code" },
    })

    // ══════════════════════════════════════════════════════════════════
    // Phase 5: Tests (parallel with self-reviews)
    // ══════════════════════════════════════════════════════════════════

    .step("impl-tests", {
      agent: "test-worker",
      task: `Write tests for the new modules. Create test files in the relay repo at ../relay.

FILE 1: src/cli/commands/on/__tests__/symlink-mount.test.ts
Test createSymlinkMount():
- Creates mountDir with correct directory structure
- Writable files are copied (not symlinked) with normal permissions
- Readonly files are copied with mode 444
- Ignored files are not present in mountDir
- _PERMISSIONS.md is generated
- syncBack() copies only modified writable files back to projectDir
- syncBack() skips readonly and ignored files
- cleanup() removes mountDir
- Handles empty directories
- Handles nested .agentignore patterns

FILE 2: packages/sdk/src/provisioner/__tests__/tar-seeder.test.ts
Test seedWorkspaceTar():
- Creates and uploads a tar.gz to the import endpoint
- Falls back to seedWorkspace when endpoint returns 404
- Throws on non-404 HTTP errors
- Respects excludeDirs
- Works for non-git directories (fallback path)

Use vitest or jest (check what the repo uses). Mock fetch for HTTP calls. Use tmp directories for filesystem tests.

Read existing test files in the repo for conventions:
- ../relay/packages/sdk/src/provisioner/__tests__/seeder.test.ts
- ../relay/src/cli/commands/on/ (check for existing test patterns)

IMPORTANT: Write test files to disk. Do NOT output to stdout.`,
      dependsOn: ["verify-impl-files"],
      verification: { type: "exit_code" },
    })

    // ══════════════════════════════════════════════════════════════════
    // Phase 6: Peer Review (after self-reviews complete)
    // ══════════════════════════════════════════════════════════════════

    .step("read-symlink-impl", {
      type: "deterministic",
      command: "cat ../relay/src/cli/commands/on/symlink-mount.ts",
      dependsOn: ["self-review-symlink"],
      captureOutput: true,
    })

    .step("read-tar-seeder", {
      type: "deterministic",
      command: "cat ../relay/packages/sdk/src/provisioner/seeder.ts",
      dependsOn: ["self-review-tar"],
      captureOutput: true,
    })

    .step("read-tar-endpoint", {
      type: "deterministic",
      command:
        "cat packages/web/app/api/v1/workspaces/\\[workspaceId\\]/fs/import/route.ts",
      dependsOn: ["self-review-endpoint"],
      captureOutput: true,
    })

    .step("read-cli-changes", {
      type: "deterministic",
      command:
        "git diff -- src/cli/commands/on/start.ts src/cli/commands/on.ts packages/sdk/src/provisioner/index.ts 2>/dev/null; cd ../relay && git diff -- src/cli/commands/on/start.ts src/cli/commands/on.ts packages/sdk/src/provisioner/index.ts 2>/dev/null; echo DONE",
      dependsOn: ["impl-cli-integration", "impl-cli-flag"],
      captureOutput: true,
    })

    .step("peer-review", {
      agent: "reviewer",
      task: `You are a peer reviewer. Review ALL implementations for correctness, security, and consistency.

SYMLINK MOUNT (../relay/src/cli/commands/on/symlink-mount.ts):
{{steps.read-symlink-impl.output}}

TAR SEEDER (../relay/packages/sdk/src/provisioner/seeder.ts):
{{steps.read-tar-seeder.output}}

TAR IMPORT ENDPOINT (packages/web/app/api/v1/workspaces/[workspaceId]/fs/import/route.ts):
{{steps.read-tar-endpoint.output}}

CLI INTEGRATION CHANGES:
{{steps.read-cli-changes.output}}

Review checklist:
1. SECURITY: No path traversal in symlink mount or tar extraction. Tar entries with ../ must be rejected.
2. SECURITY: Auth patterns match existing routes. Anonymous access works. Bad creds are rejected.
3. CORRECTNESS: Symlink mount respects .agentignore (skip) and .agentreadonly (copy + chmod 444).
4. CORRECTNESS: Tar seeder falls back gracefully on 404.
5. CORRECTNESS: CLI integration correctly chooses symlink vs tar path based on local/remote.
6. CONSISTENCY: Function signatures match the architecture doc.
7. BACKWARDS COMPAT: Existing seedWorkspace() and relayfile-mount paths are not broken.
8. ERROR HANDLING: Clear error messages. No swallowed errors.

Write your review findings to /tmp/peer-review-findings.md. For each issue found, include:
- File path and line range
- Severity (critical / warning / nit)
- What's wrong and how to fix it

Write your findings to /tmp/peer-review-findings.md when done.`,
      dependsOn: [
        "read-symlink-impl",
        "read-tar-seeder",
        "read-tar-endpoint",
        "read-cli-changes",
      ],
      verification: {
        type: "file_exists",
        value: "/tmp/peer-review-findings.md",
      },
    })

    // ══════════════════════════════════════════════════════════════════
    // Phase 7: Lead Integration Review & Fix
    // ══════════════════════════════════════════════════════════════════

    .step("read-review-findings", {
      type: "deterministic",
      command: "cat /tmp/peer-review-findings.md",
      dependsOn: ["peer-review"],
      captureOutput: true,
    })

    .step("integration-review", {
      agent: "lead",
      task: `You are the architect. The peer review is complete. Review the findings and fix any critical issues.

PEER REVIEW FINDINGS:
{{steps.read-review-findings.output}}

For each CRITICAL finding:
1. Read the relevant file
2. Fix the issue
3. Verify the fix

For WARNING findings: fix if the fix is small and safe, skip if risky.
For NITs: skip.

After fixing, do a final integration check:
1. Verify the symlink mount module exports match what start.ts imports
2. Verify seedWorkspaceTar signature matches what provisioner/index.ts calls
3. Verify the tar endpoint path matches what seedWorkspaceTar POSTs to
4. Check that the --local flag flows from on.ts through options to goOnTheRelay

Write a summary of fixes applied to /tmp/integration-fixes.md.`,
      dependsOn: ["read-review-findings", "impl-tests"],
      verification: { type: "exit_code" },
    })

    // ── Final verification ───────────────────────────────────────────
    .step("final-verify", {
      type: "deterministic",
      command: [
        'echo "=== Checking all files exist ==="',
        'missing=0',
        'for f in \\',
        '  "../relay/src/cli/commands/on/symlink-mount.ts" \\',
        '  "packages/web/app/api/v1/workspaces/[workspaceId]/fs/import/route.ts" \\',
        '  "../relay/src/cli/commands/on/__tests__/symlink-mount.test.ts" \\',
        '  "../relay/packages/sdk/src/provisioner/__tests__/tar-seeder.test.ts"; do',
        '  if [ -f "$f" ]; then echo "OK: $f"; else echo "MISSING: $f"; missing=$((missing+1)); fi',
        "done",
        'echo ""',
        'echo "=== Checking relay repo changes ==="',
        "cd ../relay && git diff --stat",
        'echo ""',
        'echo "=== Checking cloud repo changes ==="',
        "cd - > /dev/null && git diff --stat",
        'echo ""',
        'if [ $missing -gt 0 ]; then echo "FAIL: $missing files missing"; exit 1; fi',
        'echo "All checks passed"',
      ].join("\n"),
      dependsOn: ["integration-review"],
      failOnError: true,
    })

    .onError("retry", { maxRetries: 2, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

console.log("Result:", result.status);
