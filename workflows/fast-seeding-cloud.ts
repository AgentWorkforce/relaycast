/**
 * Fast Workspace Seeding — Cloud Repo
 *
 * Implements the tar import endpoint that receives gzipped tarballs
 * from the relay seeder and extracts them into workspace storage.
 *
 * Run: agent-relay run workflows/fast-seeding-cloud.ts
 * From: AgentWorkforce/cloud
 */

import { workflow } from "@relayflows/core";

const result = await workflow("fast-seeding-cloud")
  .description(
    "Implement tar import endpoint for fast workspace seeding in cloud repo"
  )
  .pattern("dag")
  .channel("wf-fast-seeding-cloud")
  .maxConcurrency(3)
  .timeout(1_800_000)

  // ── Agents ──────────────────────────────────────────────────────────
  .agent("lead", {
    cli: "claude",
    role: "Architect — designs endpoint, reviews implementation",
    retries: 2,
  })
  .agent("endpoint-worker", {
    cli: "opencode",
    model: "openai/gpt-5.4",
    role: "Implements the tar import endpoint",
    preset: "worker",
    retries: 2,
  })
  .agent("reviewer", {
    cli: "opencode",
    model: "openai/gpt-5.4",
    role: "Peer reviewer",
    preset: "reviewer",
    retries: 1,
  })

  // ════════════════════════════════════════════════════════════════════
  // Phase 1: Design
  // ════════════════════════════════════════════════════════════════════

  .step("design", {
    agent: "lead",
    task: `Design the tar import endpoint for workspace file seeding. Read these files:

- packages/web/app/api/v1/workspaces/[workspaceId]/join/route.ts — auth pattern, workspace lookup
- packages/web/app/api/v1/workspaces/route.ts — anonymous access pattern
- packages/web/lib/workspace-registry.ts — relayfile storage interaction

Design a POST endpoint at /api/v1/workspaces/[workspaceId]/fs/import that:
1. Accepts application/gzip body containing a tar.gz archive
2. Extracts files into the workspace's relayfile storage
3. Returns { imported: number }
4. Allows anonymous access (same pattern as workspace create)
5. Rejects path traversal in tar entries (../)
6. Returns 413 for payloads > 500MB
7. Returns 404 if workspace doesn't exist

Write the design to /tmp/tar-endpoint-design.md with the exact route file structure.
Output DESIGN_COMPLETE.`,
    verification: { type: "output_contains", value: "DESIGN_COMPLETE" },
  })

  .step("read-design", {
    type: "deterministic",
    command: "cat /tmp/tar-endpoint-design.md",
    dependsOn: ["design"],
    captureOutput: true,
  })

  // ════════════════════════════════════════════════════════════════════
  // Phase 2: Implementation
  // ════════════════════════════════════════════════════════════════════

  .step("impl-tar-endpoint", {
    agent: "endpoint-worker",
    task: `Implement the tar import endpoint based on this design:
{{steps.read-design.output}}

Create: packages/web/app/api/v1/workspaces/[workspaceId]/fs/import/route.ts

The endpoint must:
1. Export async POST handler
2. Validate workspaceId parameter
3. Read request body as gzipped tar stream
4. Extract tar.gz contents — reject entries containing ../
5. Write each file to workspace relayfile storage
6. Return { imported: number } with status 200
7. Auth: allow anonymous (same pattern as workspace create at packages/web/app/api/v1/workspaces/route.ts)
8. Error handling: 404 workspace not found, 413 oversized, 400 invalid tar

Read sibling routes for patterns:
- packages/web/app/api/v1/workspaces/[workspaceId]/join/route.ts
- packages/web/app/api/v1/workspaces/route.ts

IMPORTANT: Write the file to disk. Do NOT output to stdout.`,
    dependsOn: ["read-design"],
    verification: {
      type: "file_exists",
      value: "packages/web/app/api/v1/workspaces/[workspaceId]/fs/import/route.ts",
    },
  })

  // ════════════════════════════════════════════════════════════════════
  // Phase 3: Self-Review
  // ════════════════════════════════════════════════════════════════════

  .step("self-review", {
    agent: "endpoint-worker",
    task: `Review your implementation at packages/web/app/api/v1/workspaces/[workspaceId]/fs/import/route.ts.

Check for:
1. Auth pattern matches sibling routes (anonymous allowed, bad creds rejected)
2. Tar extraction handles nested directories
3. No path traversal in tar entries (reject ../)
4. 413 for oversized payloads
5. Invalid tar returns 400, not 500
6. Workspace existence verified before extraction

Fix any issues. Output SELF_REVIEW_COMPLETE.`,
    dependsOn: ["impl-tar-endpoint"],
    verification: { type: "output_contains", value: "SELF_REVIEW_COMPLETE" },
  })

  // ════════════════════════════════════════════════════════════════════
  // Phase 4: Peer Review
  // ════════════════════════════════════════════════════════════════════

  .step("read-endpoint", {
    type: "deterministic",
    command:
      "cat packages/web/app/api/v1/workspaces/\\[workspaceId\\]/fs/import/route.ts",
    dependsOn: ["self-review"],
    captureOutput: true,
  })

  .step("peer-review", {
    agent: "reviewer",
    task: `Review the tar import endpoint implementation:

{{steps.read-endpoint.output}}

Checklist:
1. SECURITY: No path traversal. Entries with ../ rejected.
2. SECURITY: Auth matches sibling routes. Anonymous works.
3. CORRECTNESS: Tar extraction writes files to correct paths
4. CORRECTNESS: Content-Length check for 413
5. ERROR HANDLING: Clear messages for 400/404/413/500

Write findings to /tmp/peer-review-cloud.md. Output PEER_REVIEW_COMPLETE.`,
    dependsOn: ["read-endpoint"],
    verification: { type: "output_contains", value: "PEER_REVIEW_COMPLETE" },
  })

  // ════════════════════════════════════════════════════════════════════
  // Phase 5: Final Fix
  // ════════════════════════════════════════════════════════════════════

  .step("read-findings", {
    type: "deterministic",
    command: "cat /tmp/peer-review-cloud.md",
    dependsOn: ["peer-review"],
    captureOutput: true,
  })

  .step("fix-issues", {
    agent: "lead",
    task: `Review and fix critical issues from peer review.

FINDINGS:
{{steps.read-findings.output}}

Fix CRITICAL issues only. Verify the endpoint file exists and compiles.
Output FIX_COMPLETE.`,
    dependsOn: ["read-findings"],
    verification: { type: "output_contains", value: "FIX_COMPLETE" },
  })

  .step("final-verify", {
    type: "deterministic",
    command: [
      'if [ -f "packages/web/app/api/v1/workspaces/[workspaceId]/fs/import/route.ts" ]; then',
      '  echo "OK: tar import endpoint exists"',
      "  git diff --stat",
      "else",
      '  echo "FAIL: endpoint missing"; exit 1',
      "fi",
    ].join("\n"),
    dependsOn: ["fix-issues"],
    failOnError: true,
  })

  .onError("retry", { maxRetries: 2, retryDelayMs: 10_000 })
  .run({ cwd: process.cwd() });

console.log("Result:", result.status);
