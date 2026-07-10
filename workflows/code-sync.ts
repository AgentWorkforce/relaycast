/**
 * Code-sync workflow — reflection swarm pattern.
 *
 * A sync-producer and sync-reviewer alternate: each producer step
 * (scan, diff, execute) is followed by a reviewer step that validates
 * the output before the next producer step proceeds.
 */

import type { RelayYamlConfig } from "@relayflows/core";

export const config: RelayYamlConfig = {
  version: "1.0",
  name: "code-sync",
  description:
    "Syncs a local project directory to a Daytona sandbox volume with reflection-based review at every stage.",
  swarm: {
    pattern: "reflection",
    maxConcurrency: 2,
    timeoutMs: 300_000,
    channel: "code-sync",
  },
  agents: [
    {
      name: "sync-producer",
      cli: "claude",
      role: "Scans, hashes, diffs, and uploads project files to the sandbox volume",
      interactive: false,
    },
    {
      name: "sync-reviewer",
      cli: "claude",
      role: "Reviews and validates each sync stage for correctness and safety",
      interactive: false,
    },
  ],
  workflows: [
    {
      name: "code-sync-flow",
      steps: [
        // ── Stage 1: Scan & Hash ──────────────────────────────────────
        {
          name: "scan-and-hash",
          type: "agent",
          agent: "sync-producer",
          task: `
Scan the project directory and compute file hashes.
Use the code-sync library to:
1. Call scanDirectory() on the project root
2. Call hashFiles() on the scan result
3. Serialize the manifest and write it to /shared/manifest.json

Output the file count and total size, then output DONE.
          `.trim(),
          verification: {
            type: "output_contains",
            value: "DONE",
          },
        },
        {
          name: "review-scan",
          type: "agent",
          agent: "sync-reviewer",
          dependsOn: ["scan-and-hash"],
          task: `
Review the scan manifest at /shared/manifest.json:
1. Verify it is valid JSON with version, root, and entries fields
2. Check that no .git/ or node_modules/ paths leaked through
3. Verify all hashes are 64-character hex strings (SHA-256)
4. Report the file count

If everything is valid, output PASS. If issues found, output FAIL with details.
Output DONE when complete.
          `.trim(),
          verification: {
            type: "output_contains",
            value: "DONE",
          },
        },

        // ── Stage 2: Diff & Plan ──────────────────────────────────────
        {
          name: "diff-and-plan",
          type: "agent",
          agent: "sync-producer",
          dependsOn: ["review-scan"],
          task: `
Produce a sync plan by diffing the local manifest against the remote.
1. Read /shared/manifest.json (local manifest)
2. Attempt to fetch the remote manifest from the sandbox
3. Call diffManifests() to produce a sync plan
4. Write the plan to /shared/sync-plan.json

Output the counts: added, modified, deleted, unchanged. Then output DONE.
          `.trim(),
          verification: {
            type: "output_contains",
            value: "DONE",
          },
        },
        {
          name: "review-plan",
          type: "agent",
          agent: "sync-reviewer",
          dependsOn: ["diff-and-plan"],
          task: `
Review the sync plan at /shared/sync-plan.json:
1. Validate the plan structure (added, modified, deleted, unchanged arrays)
2. Verify stats.toUpload equals added.length + modified.length
3. Check for suspicious files (secrets, credentials, .env files) in the upload list
4. Verify no path traversal attempts (../) in file paths

If everything is valid, output PASS. If issues found, output FAIL with details.
Output DONE when complete.
          `.trim(),
          verification: {
            type: "output_contains",
            value: "DONE",
          },
        },

        // ── Stage 3: Execute Sync ─────────────────────────────────────
        {
          name: "execute-sync",
          type: "agent",
          agent: "sync-producer",
          dependsOn: ["review-plan"],
          task: `
Execute the sync plan:
1. Read the approved plan from /shared/sync-plan.json
2. Upload added and modified files to the sandbox
3. Delete removed files from the sandbox
4. Upload the updated manifest to the sandbox
5. Write a summary to /shared/sync-result.json

Report: uploaded count, deleted count, error count. Then output DONE.
          `.trim(),
          verification: {
            type: "output_contains",
            value: "DONE",
          },
        },
        {
          name: "review-sync",
          type: "agent",
          agent: "sync-reviewer",
          dependsOn: ["execute-sync"],
          task: `
Review the sync result at /shared/sync-result.json:
1. Verify uploaded count matches the plan's toUpload
2. Verify deleted count matches the plan's toDelete
3. Check for any errors in the error array
4. Produce a final verdict: PASS or FAIL

Output PASS or FAIL with a summary. Then output DONE.
          `.trim(),
          verification: {
            type: "output_contains",
            value: "DONE",
          },
        },

        // ── Stage 4: Generate Patch ─────────────────────────────────────
        {
          name: "generate-patch",
          type: "agent",
          agent: "sync-producer",
          dependsOn: ["review-sync"],
          task: `
Generate a git patch capturing all changes made by agents:
1. Run generatePatch() on the sandbox to produce /shared/changes.patch
2. Report whether changes were detected
3. If changes exist, report the patch size

Output DONE when complete.
          `.trim(),
          verification: {
            type: "output_contains",
            value: "DONE",
          },
        },
        {
          name: "review-patch",
          type: "agent",
          agent: "sync-reviewer",
          dependsOn: ["generate-patch"],
          task: `
Review the generated patch at /shared/changes.patch:
1. Verify the patch file exists and is non-empty (if changes were reported)
2. Check patch format is valid (starts with diff headers)
3. Verify no sensitive files are included (.env, credentials, secrets)
4. Report the number of files changed

Output PASS or FAIL with details. Then output DONE.
          `.trim(),
          verification: {
            type: "output_contains",
            value: "DONE",
          },
        },
      ],
    },
  ],
  errorHandling: {
    strategy: "fail-fast",
  },
};
