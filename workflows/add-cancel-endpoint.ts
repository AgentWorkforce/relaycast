/**
 * add-cancel-endpoint.ts
 *
 * Adds POST /api/v1/workflows/runs/{runId}/cancel endpoint.
 * Stops the Daytona sandbox, updates run status to 'cancelled',
 * and revokes the API token session.
 *
 * Run: agent-relay run workflows/add-cancel-endpoint.ts
 */

import { workflow } from '@relayflows/core';

const result = await workflow('add-cancel-endpoint')
  .description('Add workflow run cancel endpoint')
  .pattern('pipeline')
  .channel('wf-cancel-endpoint')
  .maxConcurrency(2)
  .timeout(3600000)

  .agent('dev', {
    cli: 'claude',
    role: 'Adds cancel endpoint to the cloud API',
  })

  // ── Step 1: Create the cancel route ───────────────────────────────

  .step('read-run-route', {
    type: 'deterministic',
    command: 'cat packages/web/app/api/v1/workflows/runs/\\[runId\\]/route.ts',
    captureOutput: true,
  })

  .step('read-callback-route', {
    type: 'deterministic',
    command: 'cat packages/web/app/api/v1/workflows/callback/route.ts',
    captureOutput: true,
  })

  .step('read-workflow-store', {
    type: 'deterministic',
    command: 'grep -n "interface\\|create\\|update\\|get\\|delete\\|status" packages/web/lib/workflows.ts | head -30',
    captureOutput: true,
  })

  .step('create-cancel-route', {
    agent: 'dev',
    dependsOn: ['read-run-route', 'read-callback-route', 'read-workflow-store'],
    task: `Create the file packages/web/app/api/v1/workflows/runs/[runId]/cancel/route.ts

Reference — existing run route:
{{steps.read-run-route.output}}

Reference — callback route (for auth pattern):
{{steps.read-callback-route.output}}

Reference — workflow store interface:
{{steps.read-workflow-store.output}}

Write a POST handler that cancels a running workflow:

\`\`\`typescript
import { NextRequest, NextResponse } from "next/server";
import { Daytona } from "@daytonaio/sdk";
import { requireAuthRunAccess, requireAuthScope, resolveRequestAuth } from "@/lib/auth/request-auth";
import { revokeApiTokenSessionsForRun } from "@/lib/auth/api-token-store";
import { workflowStore } from "@/lib/workflows";
import { resolveServerDaytonaAuthParams } from "@/lib/daytona-auth";

type RouteContext = {
  params: { runId: string } | Promise<{ runId: string }>;
};

export async function POST(request: NextRequest, { params }: RouteContext) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!requireSessionAuth(auth) && !requireAuthScope(auth, "cli:auth")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { runId } = await params;
  const run = await workflowStore.get(runId);
  if (!run || run.userId !== auth.userId) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
    return NextResponse.json({ error: "Run already " + run.status }, { status: 409 });
  }

  // Stop and delete the Daytona sandbox
  if (run.sandboxId) {
    try {
      const daytonaAuth = resolveServerDaytonaAuthParams();
      const daytona = new Daytona(daytonaAuth);
      const sandbox = await daytona.get(run.sandboxId);
      await daytona.stop(sandbox);
      await daytona.delete(sandbox);
    } catch (err) {
      // Sandbox may already be stopped/deleted — continue with status update
      console.warn("[cancel] Sandbox cleanup error (non-fatal):", err instanceof Error ? err.message : err);
    }
  }

  // Update run status
  await workflowStore.update(runId, { status: "cancelled" });

  // Revoke API tokens for this run
  await revokeApiTokenSessionsForRun(runId, "run_cancelled").catch(() => {});

  return NextResponse.json({ runId, status: "cancelled" });
}
\`\`\`

Make sure to also import requireSessionAuth if it's not in the import list above — check the run route for the correct import.

IMPORTANT: Write to disk at packages/web/app/api/v1/workflows/runs/[runId]/cancel/route.ts
Only create this one file.`,
    verification: { type: 'file_exists', value: 'packages/web/app/api/v1/workflows/runs/[runId]/cancel/route.ts' },
  })

  // ── Step 2: Add 'cancelled' to workflow store if needed ───────────

  .step('read-workflow-store-full', {
    type: 'deterministic',
    dependsOn: ['create-cancel-route'],
    command: 'cat packages/web/lib/workflows.ts',
    captureOutput: true,
  })

  .step('edit-workflow-store', {
    agent: 'dev',
    dependsOn: ['read-workflow-store-full'],
    task: `Edit packages/web/lib/workflows.ts

Current contents:
{{steps.read-workflow-store-full.output}}

Check if the status type includes 'cancelled'. If not, add it.
Look for a type like: status: 'pending' | 'running' | 'completed' | 'failed'
And add: | 'cancelled'

If 'cancelled' is already there, make no changes.

Only edit this one file.`,
    verification: { type: 'exit_code' },
  })

  // ── Step 3: Add cancel command to CLI ─────────────────────────────

  .step('read-cli-workflows', {
    type: 'deterministic',
    dependsOn: ['edit-workflow-store'],
    command: 'cat packages/cli/src/workflows.ts',
    captureOutput: true,
  })

  .step('edit-cli', {
    agent: 'dev',
    dependsOn: ['read-cli-workflows'],
    task: `Edit packages/cli/src/workflows.ts

Current contents:
{{steps.read-cli-workflows.output}}

Add a cancelWorkflow function:

async function cancelWorkflow(runId: string, apiUrl: string, token: string) {
  const res = await fetch(apiUrl + '/api/v1/workflows/runs/' + runId + '/cancel', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error('Cancel failed: ' + (err.error ?? res.statusText));
  }
  return res.json();
}

Export it so the CLI entry point can wire it to a command like: cloud run cancel <runId>

Only edit this one file.`,
    verification: { type: 'exit_code' },
  })

  // ── Step 4: Build check + commit ──────────────────────────────────

  .step('build-check', {
    type: 'deterministic',
    dependsOn: ['edit-cli'],
    command: 'npx tsc --noEmit 2>&1 | tail -20; echo "EXIT: $?"',
    captureOutput: true,
    failOnError: false,
  })

  .step('fix-build', {
    agent: 'dev',
    dependsOn: ['build-check'],
    task: `Fix any TypeScript errors.

Build output:
{{steps.build-check.output}}

If EXIT: 0, do nothing. Otherwise read failing files and fix them.`,
    verification: { type: 'exit_code' },
  })

  .step('commit', {
    type: 'deterministic',
    dependsOn: ['fix-build'],
    command: `git add packages/web/app/api/v1/workflows/runs/\\[runId\\]/cancel/ packages/web/lib/workflows.ts packages/cli/src/workflows.ts && \
git diff --cached --name-only && \
git commit -m "feat: add POST /runs/{runId}/cancel endpoint

Stops the Daytona sandbox, updates run status to cancelled,
and revokes API token sessions.

CLI: cloud run cancel <runId>
API: POST /api/v1/workflows/runs/{runId}/cancel"`,
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

console.log(`\nCancel endpoint workflow: ${result.status}`);
if (result.status === 'completed') {
  console.log('API: POST /api/v1/workflows/runs/{runId}/cancel');
  console.log('CLI: cloud run cancel <runId>');
}
