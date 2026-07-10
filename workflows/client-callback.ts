/**
 * client-callback.ts
 *
 * Adds client callback/webhook support to the cloud workflow platform:
 *
 *   1. Workspace-level `webhookUrl` — persistent default callback URL
 *   2. Per-run `clientCallbackUrl` — override in POST /workflows/run
 *   3. Callback forwarding — when a run completes, POST result to client
 *   4. Workspace webhook settings API — GET/PUT for managing default URL
 *
 * Resolution order: clientCallbackUrl (per-run) → workspace webhookUrl → skip
 *
 * Run: agent-relay run workflows/client-callback.ts
 */

import { workflow } from '@relayflows/core';

const CLOUD = '/Users/khaliqgant/Projects/AgentWorkforce/cloud/.worktrees/client-callback';

(async () => {
const result = await workflow('client-callback')
    .description('Add client callback/webhook support for workflow completion notifications')
    .pattern('dag')
    .channel('wf-client-callback')
    .maxConcurrency(4)
    .timeout(3_600_000)

    .agent('dev', {
      cli: 'claude',
      preset: 'worker',
      role: 'Implements schema changes, API routes, and callback forwarding',
    })

    // ════════════════════════════════════════════════════════════════
    // PHASE 1: Read all source files in parallel
    // ════════════════════════════════════════════════════════════════

    .step('read-schema', {
      type: 'deterministic',
      command: `cat ${CLOUD}/packages/web/lib/db/schema.ts`,
      captureOutput: true,
    })

    .step('read-workflows-lib', {
      type: 'deterministic',
      command: `cat ${CLOUD}/packages/web/lib/workflows.ts`,
      captureOutput: true,
    })

    .step('read-run-route', {
      type: 'deterministic',
      command: `cat ${CLOUD}/packages/web/app/api/v1/workflows/run/route.ts`,
      captureOutput: true,
    })

    .step('read-callback-route', {
      type: 'deterministic',
      command: `cat ${CLOUD}/packages/web/app/api/v1/workflows/callback/route.ts`,
      captureOutput: true,
    })

    .step('read-journal', {
      type: 'deterministic',
      command: `cat ${CLOUD}/packages/web/drizzle/meta/_journal.json`,
      captureOutput: true,
    })

    // ════════════════════════════════════════════════════════════════
    // PHASE 2: Edit files in parallel
    // ════════════════════════════════════════════════════════════════

    // --- Schema: add webhookUrl to workspaces + clientCallbackUrl to workflow_runs ---

    .step('edit-schema', {
      agent: 'dev',
      dependsOn: ['read-schema'],
      task: `Edit the file ${CLOUD}/packages/web/lib/db/schema.ts

Current contents:
{{steps.read-schema.output}}

Make two changes:

1. Add \`webhookUrl\` to the \`workspaces\` table (nullable text column):
   webhookUrl: text("webhook_url"),
   Add it before \`createdAt\`.

2. Add \`clientCallbackUrl\` to the \`workflowRuns\` table (nullable text column):
   clientCallbackUrl: text("client_callback_url"),
   Add it after \`callbackToken\`.

IMPORTANT: Write the file to disk using your file-writing tools. Do NOT just output the code to stdout.
Only edit this one file.`,
      verification: { type: 'exit_code' },
    })

    // --- Workflows lib: add clientCallbackUrl to WorkflowCreateInput + WorkflowRecord ---

    .step('edit-workflows-lib', {
      agent: 'dev',
      dependsOn: ['read-workflows-lib'],
      task: `Edit the file ${CLOUD}/packages/web/lib/workflows.ts

Current contents:
{{steps.read-workflows-lib.output}}

Make these changes:

1. Add \`clientCallbackUrl?: string\` to the \`WorkflowRecord\` interface (after callbackToken).

2. Add \`clientCallbackUrl?: string\` to the \`WorkflowCreateInput\` interface (after callbackToken).

3. In \`rowToRecord()\`, add: \`clientCallbackUrl: row.clientCallbackUrl ?? undefined,\`

4. In the \`create()\` method inside \`workflowStore\`, add \`clientCallbackUrl: input.clientCallbackUrl ?? null,\` to the values object.

5. Add a new method to \`workflowStore\` to get the workspace webhook URL:

   async getWorkspaceWebhookUrl(workspaceId: string): Promise<string | null> {
     const db = getDb();
     const rows = await db
       .select({ webhookUrl: workspaces.webhookUrl })
       .from(workspaces)
       .where(eq(workspaces.id, workspaceId))
       .limit(1);
     return rows[0]?.webhookUrl ?? null;
   },

   async updateWorkspaceWebhookUrl(workspaceId: string, webhookUrl: string | null): Promise<void> {
     const db = getDb();
     await db
       .update(workspaces)
       .set({ webhookUrl, updatedAt: new Date() })
       .where(eq(workspaces.id, workspaceId));
   },

   Make sure to import \`workspaces\` from the schema if not already imported.

IMPORTANT: Write the file to disk using your file-writing tools. Do NOT just output the code to stdout.
Only edit this one file.`,
      verification: { type: 'exit_code' },
    })

    // --- Run route: accept clientCallbackUrl + store it ---

    .step('edit-run-route', {
      agent: 'dev',
      dependsOn: ['read-run-route'],
      task: `Edit the file ${CLOUD}/packages/web/app/api/v1/workflows/run/route.ts

Current contents:
{{steps.read-run-route.output}}

Make these changes:

1. Add \`clientCallbackUrl?: string\` to the \`RunRequestBody\` type.

2. Add validation in \`isRunRequestBody\`: clientCallbackUrl is optional, if present must be a string starting with "https://".

3. In the \`workflowStore.create()\` call, pass \`clientCallbackUrl: body.clientCallbackUrl\`.

IMPORTANT: Write the file to disk using your file-writing tools. Do NOT just output the code to stdout.
Only edit this one file.`,
      verification: { type: 'exit_code' },
    })

    // --- Callback route: forward completion to client ---

    .step('edit-callback-route', {
      agent: 'dev',
      dependsOn: ['read-callback-route'],
      task: `Edit the file ${CLOUD}/packages/web/app/api/v1/workflows/callback/route.ts

Current contents:
{{steps.read-callback-route.output}}

After the existing \`workflowStore.update()\` call and the token revocation block, add client callback forwarding.

Add this logic BEFORE the final return statement:

1. Import \`workflowStore\` methods (getWorkspaceWebhookUrl is already on workflowStore).

2. Resolve the client callback URL with this priority:
   - \`run.clientCallbackUrl\` (per-run override)
   - fall back to \`await workflowStore.getWorkspaceWebhookUrl(run.workspaceId)\`
   - if neither exists, skip forwarding

3. If a callback URL is resolved, fire-and-forget a POST to it:

   const clientCallbackUrl = run.clientCallbackUrl ?? await workflowStore.getWorkspaceWebhookUrl(run.workspaceId);
   if (clientCallbackUrl) {
     // Fire-and-forget — don't block the sandbox callback response
     fetch(clientCallbackUrl, {
       method: 'POST',
       headers: {
         'Content-Type': 'application/json',
         'X-Callback-Token': run.callbackToken,
         'X-Run-Id': body.runId,
       },
       body: JSON.stringify({
         runId: body.runId,
         status: body.status,
         result: body.result,
         error: body.error,
       }),
     }).catch((err) => {
       console.error(\`[callback] Failed to forward to client \${clientCallbackUrl}:\`, err.message);
     });
   }

IMPORTANT: Write the file to disk using your file-writing tools. Do NOT just output the code to stdout.
Only edit this one file.`,
      verification: { type: 'exit_code' },
    })

    // --- Create migration ---

    .step('create-migration', {
      agent: 'dev',
      dependsOn: ['read-journal'],
      task: `Create a new migration file at ${CLOUD}/packages/web/drizzle/0008_client_callback_webhook.sql

Contents:
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS webhook_url TEXT;
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS client_callback_url TEXT;

Then update the journal at ${CLOUD}/packages/web/drizzle/meta/_journal.json

Current journal:
{{steps.read-journal.output}}

Add a new entry with idx: 6, tag: "0008_client_callback_webhook", when: 1774500000000 (must be higher than all existing timestamps).

IMPORTANT: Write BOTH files to disk using your file-writing tools. Do NOT just output the code to stdout.`,
      verification: { type: 'file_exists', value: `${CLOUD}/packages/web/drizzle/0008_client_callback_webhook.sql` },
    })

    // --- Create workspace webhook settings API ---

    .step('create-webhook-settings-route', {
      agent: 'dev',
      dependsOn: ['read-run-route'],
      task: `Create a new file at ${CLOUD}/packages/web/app/api/v1/workspaces/webhook/route.ts

This is a Next.js App Router route. Write GET and PUT handlers for managing the workspace webhook URL.

Use the same auth pattern as the run route (resolveRequestAuth + requireSessionAuth).

GET /api/v1/workspaces/webhook:
- Returns { webhookUrl: string | null }

PUT /api/v1/workspaces/webhook:
- Accepts { webhookUrl: string | null }
- Validates webhookUrl starts with "https://" if not null
- Updates via workflowStore.updateWorkspaceWebhookUrl()
- Returns { webhookUrl: string | null }

Import from:
- "@/lib/auth/resolve-request-auth" for resolveRequestAuth
- "@/lib/auth/require-auth" for requireSessionAuth
- "@/lib/workflows" for workflowStore

IMPORTANT: Write the file to disk using your file-writing tools. Do NOT just output the code to stdout.
Only create this one file.`,
      verification: { type: 'file_exists', value: `${CLOUD}/packages/web/app/api/v1/workspaces/webhook/route.ts` },
    })

    // ════════════════════════════════════════════════════════════════
    // PHASE 3: Verify + commit
    // ════════════════════════════════════════════════════════════════

    .step('verify-files', {
      type: 'deterministic',
      dependsOn: [
        'edit-schema', 'edit-workflows-lib', 'edit-run-route',
        'edit-callback-route', 'create-migration', 'create-webhook-settings-route',
      ],
      command: `cd ${CLOUD} && missing=0; for f in \
        packages/web/lib/db/schema.ts \
        packages/web/lib/workflows.ts \
        packages/web/app/api/v1/workflows/run/route.ts \
        packages/web/app/api/v1/workflows/callback/route.ts \
        packages/web/drizzle/0008_client_callback_webhook.sql \
        packages/web/app/api/v1/workspaces/webhook/route.ts; do \
        if [ ! -f "$f" ]; then echo "MISSING: $f"; missing=$((missing+1)); fi; \
      done; \
      for f in \
        packages/web/lib/db/schema.ts \
        packages/web/lib/workflows.ts \
        packages/web/app/api/v1/workflows/run/route.ts \
        packages/web/app/api/v1/workflows/callback/route.ts; do \
        if git diff --quiet "$f" 2>/dev/null; then echo "NOT MODIFIED: $f"; missing=$((missing+1)); fi; \
      done; \
      if [ $missing -gt 0 ]; then echo "$missing issues found"; exit 1; fi; \
      echo "All files present and modified" && git diff --stat`,
      captureOutput: true,
      failOnError: true,
    })

    .step('commit', {
      type: 'deterministic',
      dependsOn: ['verify-files'],
      command: `cd ${CLOUD} && \
git add -A && \
git diff --cached --stat && \
git commit -m "feat: add client callback/webhook for workflow completion notifications

- Add webhookUrl to workspaces table (persistent default)
- Add clientCallbackUrl to workflow_runs (per-run override)
- Forward completion events to client: clientCallbackUrl → webhookUrl → skip
- Add GET/PUT /api/v1/workspaces/webhook settings endpoint
- Migration 0008: add webhook_url and client_callback_url columns"`,
      captureOutput: true,
      failOnError: true,
    })

    .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
    .run({ cwd: CLOUD });

console.log(`\nClient callback workflow: ${result.status}`);
if (result.status === 'completed') {
  console.log('\nChanges:');
  console.log('  - workspaces.webhook_url — persistent default callback');
  console.log('  - workflow_runs.client_callback_url — per-run override');
  console.log('  - Callback handler forwards to client on completion');
  console.log('  - GET/PUT /api/v1/workspaces/webhook — settings API');
}
})();
