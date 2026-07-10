/**
 * runtime-v6-worker-onboarding.ts
 *
 * Phase 6 of the runtime adapter refactor — user-facing onboarding for
 * worker-dispatched runtimes (replaces the earlier OpenClaw gatewayd
 * onboarding).
 *
 * Builds the thin layer that turns the v4 worker-dispatch API into a
 * copy-paste install experience:
 *
 *   agent-relay worker register --workspace rw_xxxx --token ocl_wrk_enr_xxx
 *   agent-relay worker start --daemon
 *
 * Files touched:
 *
 *   Web UI:
 *     packages/web/app/workspaces/[workspaceId]/runtimes/page.tsx
 *     packages/web/app/workspaces/[workspaceId]/runtimes/workers/page.tsx
 *     packages/web/app/workspaces/[workspaceId]/runtimes/workers/new/page.tsx
 *     packages/web/components/workers/*.tsx
 *
 *   Enrollment token API (user-facing side of the v4 endpoints):
 *     packages/web/app/api/v1/workers/enrollment-tokens/route.ts
 *
 *   Workspace default runtime setting:
 *     packages/web/drizzle/migrations/NNNN_workspace_default_runtime.sql
 *     packages/web/drizzle/schema/workspaces.ts (add default_runtime column)
 *     packages/web/app/api/v1/workspaces/[workspaceId]/runtime/route.ts
 *
 * Prerequisite:
 *   - runtime-v4-worker-dispatch.ts must have been merged (this workflow
 *     builds on the tables, API routes, and lib helpers from v4)
 *
 * Out of scope (separate repo):
 *   - The `agent-relay worker` CLI subcommand itself
 *     (see docs/runtimes/specs/worker-dispatch.md section "agent-relay
 *      worker subcommand" for the handoff spec)
 *
 * Run: agent-relay run workflows/runtime-v6-worker-onboarding.ts
 */

import { CodexModels, workflow } from '@relayflows/core';

async function main() {
  const result = await workflow('runtime-v6-worker-onboarding')
    .description('Web UI + enrollment token mint + workspace default runtime setting')
    .pattern('dag')
    .channel('wf-runtime-v6')
    .maxConcurrency(6)
    .timeout(2_700_000)

    .agent('lead', {
      cli: 'codex',
      role: 'Architect — plans UI shape, token flow, workspace setting wiring',
      // Non-interactive headless Codex avoids PTY idle-kill during long
      // plan/reflect prompts while keeping the analyst-style read-only flow.
      preset: 'analyst',
      interactive: false,
      retries: 1,
      constraints: { model: CodexModels.GPT_5_4 },
      permissions: {
        access: 'readonly',
        files: {
          read: [
            'docs/runtimes/specs/worker-dispatch.md',
            'packages/web/app/workspaces/**',
            'packages/web/app/api/v1/workers/**',
            'packages/web/components/**',
            'packages/web/lib/workers/**',
            'packages/web/drizzle/schema/**',
          ],
          write: [],
          deny: [],
        },
        exec: [],
      },
    })

    .agent('impl-api', {
      cli: 'codex',
      role: 'Implementer — enrollment token endpoint, workspace default runtime',
      preset: 'worker',
      retries: 2,
      constraints: { model: CodexModels.GPT_5_3_CODEX },
      permissions: {
        access: 'restricted',
        files: {
          read: ['packages/web/**', 'packages/core/**', 'docs/runtimes/specs/worker-dispatch.md'],
          write: [
            'packages/web/app/api/v1/workers/enrollment-tokens/route.ts',
            'packages/web/app/api/v1/workspaces/[workspaceId]/runtime/route.ts',
            'packages/web/drizzle/schema/workspaces.ts',
            'packages/web/drizzle/migrations/**',
            'packages/web/lib/workers/onboarding.ts',
          ],
          deny: [
            'packages/core/**',
            'packages/web/app/api/v1/workers/register/**',
            'packages/web/app/api/v1/workers/[workerId]/**',
            '.env*',
            'infra/**',
          ],
        },
        exec: [],
      },
    })

    .agent('impl-ui', {
      cli: 'codex',
      role: 'Implementer — workspace settings UI pages and components',
      preset: 'worker',
      retries: 2,
      constraints: { model: CodexModels.GPT_5_3_CODEX },
      permissions: {
        access: 'restricted',
        files: {
          read: ['packages/web/**', 'docs/runtimes/specs/worker-dispatch.md'],
          write: [
            'packages/web/app/workspaces/[workspaceId]/runtimes/**',
            'packages/web/components/workers/**',
          ],
          deny: [
            'packages/web/app/api/**',
            'packages/web/drizzle/**',
            'packages/core/**',
            '.env*',
          ],
        },
        exec: [],
      },
    })

    .agent('reviewer', {
      cli: 'codex',
      role: 'Peer reviewer — UX + security (token display, XSS, session checks)',
      preset: 'reviewer',
      retries: 1,
      constraints: { model: CodexModels.GPT_5_4 },
      permissions: {
        access: 'readonly',
        files: { read: ['packages/web/**', 'docs/**'], write: [], deny: [] },
        exec: [],
      },
    })

    // ─── Phase 1: Read context ─────────────────────────────────────────

    .step('read-spec', {
      type: 'deterministic',
      command: 'cat docs/runtimes/specs/worker-dispatch.md',
      captureOutput: true,
      failOnError: true,
    })

    .step('read-workspace-settings-pattern', {
      type: 'deterministic',
      command: [
        'echo "=== existing workspace settings pages ==="',
        'find packages/web/app/workspaces -type d 2>/dev/null | head -20',
        'echo',
        'echo "=== sample page.tsx for style ==="',
        'find packages/web/app/workspaces -name "page.tsx" 2>/dev/null | head -3',
        'find packages/web/app/workspaces -name "page.tsx" 2>/dev/null | head -1 | xargs cat 2>/dev/null | head -60 || true',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })

    .step('read-v4-worker-lib', {
      type: 'deterministic',
      command: [
        'echo "=== v4 worker lib (what this workflow reuses) ==="',
        'ls -la packages/web/lib/workers/ 2>/dev/null',
        'echo',
        'grep -n "mintEnrollmentToken\\|redeemEnrollmentToken" packages/web/lib/workers/tokens.ts 2>/dev/null',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })

    .step('read-workspaces-schema', {
      type: 'deterministic',
      command: [
        'echo "=== workspaces schema ==="',
        'find packages/web/drizzle/schema -name "*.ts" -exec grep -l "workspace" {} \\; 2>/dev/null | head -3',
        'echo',
        'find packages/web/drizzle/schema -name "workspaces*" 2>/dev/null | head -1 | xargs cat 2>/dev/null | head -40 || true',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })

    .step('read-components-style', {
      type: 'deterministic',
      command: [
        'echo "=== component library used by the app ==="',
        'ls packages/web/components 2>/dev/null | head -20',
        'echo',
        'grep -rn "@/components/ui\\|import.*Button\\|import.*Dialog" packages/web/app 2>/dev/null | head -5',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })

    // ─── Phase 2: Plan ─────────────────────────────────────────────────

    .step('plan', {
      agent: 'lead',
      dependsOn: ['read-spec', 'read-workspace-settings-pattern', 'read-v4-worker-lib', 'read-workspaces-schema', 'read-components-style'],
      task: `Plan the worker onboarding user experience.

Worker-dispatch spec:
{{steps.read-spec.output}}

Existing workspace settings pages (match the style):
{{steps.read-workspace-settings-pattern.output}}

v4 worker lib (what we reuse):
{{steps.read-v4-worker-lib.output}}

Workspaces schema (to add default_runtime column):
{{steps.read-workspaces-schema.output}}

Component library (buttons, dialogs, forms, toasts):
{{steps.read-components-style.output}}

## A. API additions

1. **POST /api/v1/workers/enrollment-tokens**
   - Auth: user session + workspace membership (user must be admin/owner of the workspace)
   - Body: { workspaceId, name?, tags?[] }  (name and tags are optional hints for the worker operator)
   - Calls mintEnrollmentToken from v4 lib
   - Returns:
     {
       token: "ocl_wrk_enr_xxxx",
       expiresAt: "...",
       registerCommand: "agent-relay worker register --workspace rw_xxx --token ocl_wrk_enr_xxxx --name macmini-01",
       startCommand: "agent-relay worker start --daemon"
     }
   - Rate limit: 20/hour per user to prevent spam

2. **PUT /api/v1/workspaces/:workspaceId/runtime**
   - Auth: user session + workspace admin
   - Body: { runtime: { id: string, config?: unknown } }
   - Validates: if id === 'worker', config.workerId must exist and belong to this workspace
   - Updates workspaces.default_runtime column
   - Returns the updated record

3. **GET /api/v1/workspaces/:workspaceId/runtime**
   - Auth: user session + workspace membership
   - Returns current default_runtime or { id: 'daytona' } if unset

## B. DB schema

Modify: **packages/web/drizzle/schema/workspaces.ts**
Add column: default_runtime JSONB NULLABLE
  (stores { id: string, config?: unknown } — null means fall back to Daytona)

Migration: **packages/web/drizzle/migrations/NNNN_workspace_default_runtime.sql**
  ALTER TABLE workspaces ADD COLUMN default_runtime JSONB;

No index needed — this is a per-workspace singleton field.

## C. Helper lib

**packages/web/lib/workers/onboarding.ts**
Centralizes the command-string formatting so the UI and API agree:

  export function buildRegisterCommand(opts: {
    workspaceId: string;
    token: string;
    name?: string;
    tags?: string[];
  }): string

  export function buildStartCommand(opts: { daemon?: boolean }): string

  This lets the UI call the same helper as the API when showing the
  copyable block, ensuring the two never drift.

## D. Web UI pages

### packages/web/app/workspaces/[workspaceId]/runtimes/page.tsx

Server component. Landing for the "Runtimes" workspace settings section.
Sections:
  1. Default runtime card — shows current default, link to change it
  2. Workers list — link to workers/page
  3. (Future) Sandbox providers list — placeholder for now
Minimal — just routes the user to the right sub-section.

### packages/web/app/workspaces/[workspaceId]/runtimes/workers/page.tsx

Server component. Lists all workers for the workspace.
  - Calls GET /api/v1/workers (with workspaceId context)
  - Renders a table: name, display name, status badge, tags, last seen, gatewayd version
  - Row actions: view, set as default, revoke
  - "Add Worker" button at top → links to ./new

### packages/web/app/workspaces/[workspaceId]/runtimes/workers/new/page.tsx

Server component + small client island. The enrollment flow:
  1. Form: name (required), tags (optional, comma-separated)
  2. Submit button → POSTs to /api/v1/workers/enrollment-tokens
  3. On success, displays the install commands in copyable code blocks with copy buttons
  4. Shows a live polling region ("Waiting for worker to come online...") that polls GET /api/v1/workers?workspaceId=... every 3 seconds and looks for a new worker matching the name submitted
  5. When the worker appears with status='online', show a success card and a link to the workers list

### packages/web/components/workers/

  - WorkerStatusBadge.tsx — renders the status pill with the right color
  - CopyableCommand.tsx — code block with a copy-to-clipboard button (client component)
  - WorkersTable.tsx — the list table
  - NewWorkerForm.tsx — the submit form (client component)
  - EnrollmentSuccess.tsx — the post-submit view with copyable commands and polling region (client component)

## E. Default runtime UX

On the runtimes landing page, show a dropdown or card that lets the
user pick the default runtime:
  - Daytona (current default)
  - Worker: <list of online workers>
  - Any other registered RuntimeRegistry entries (from v5)

When user picks a worker, PUT /api/v1/workspaces/:id/runtime.

This replaces the "set as default" row action on the workers table as
the primary path — the row action is a shortcut, not the only way.

## F. What NOT to do in this workflow

- Do NOT re-implement the worker registration or heartbeat endpoints
  (already in v4).
- Do NOT modify packages/core/** (this is web-only).
- Do NOT implement the \`agent-relay worker\` CLI subcommand (separate
  repo).
- Do NOT add audit logging (phase 4).
- Do NOT implement tag-based pool selection UI (phase 4).

End with PLAN_COMPLETE.`,
      verification: { type: 'output_contains', value: 'PLAN_COMPLETE' },
    })

    // ─── Phase 3: Self-reflection ──────────────────────────────────────

    .step('reflect', {
      agent: 'lead',
      dependsOn: ['plan'],
      task: `Self-reflect on the worker onboarding plan.

Plan:
{{steps.plan.output}}

Challenges:

1. **Token display**: the enrollment token appears in the browser after
   POST. It must NOT be persisted in browser localStorage or leaked via
   console.log. The copyable block should show it once and warn the
   user: "this token is only shown once; copy it now". Add this to the
   EnrollmentSuccess component requirements.

2. **Polling vs SSE**: the plan uses polling (every 3s) for the "waiting
   for worker online" UI. Why not SSE? SSE would be cleaner but requires
   another endpoint and lifecycle. For v6, polling is fine — 3s interval,
   auto-stops after 5 min of no change, auto-stops on page unload. Add
   these limits to the plan.

3. **Name collision on enrollment**: the user submits a name in the
   form, but the name isn't reserved until the Mac mini actually
   registers. Two users could submit the same name and both tokens
   would work until the first one registers. Acceptable for v6 —
   collision is rejected at register time per v4. UI should handle
   the 409 gracefully.

4. **Worker selection in default runtime dropdown**: only online workers
   should be selectable. If the user picks a worker as default, then
   that worker goes offline, what happens? Workflow runs with
   runtime=worker would either (a) queue until it comes back, or (b)
   fail immediately. v4's behavior is (a) with a 10-min queue deadline.
   UI should show a warning on the default runtime card if the selected
   worker is currently offline: "Default worker is offline. New
   workflows will queue for up to 10 minutes."

5. **Workspace admin check**: only workspace admins/owners should be
   able to mint enrollment tokens or change the default runtime. Grep
   for the existing admin-check helper in the repo. If it doesn't
   exist, use the same membership check used by other admin-only routes
   and add a TODO for a dedicated role system.

6. **XSS in copyable commands**: the register command embeds a token
   that came from a trusted source (our API), but the workspace id and
   name are user-controlled. Escape them properly — React's default
   escaping handles this, but make sure CopyableCommand uses textContent,
   not dangerouslySetInnerHTML.

7. **Workspace default runtime default**: if workspaces.default_runtime
   is NULL, the cloud falls back to Daytona per v4. The UI should show
   "Daytona (default)" when the column is null. Confirm the landing page
   handles this case.

8. **Polling stop condition**: the polling region in NewWorkerForm must
   stop on: (a) worker appears with status='online', (b) 5 min elapsed,
   (c) page unload, (d) user clicks "cancel". Use React's useEffect
   cleanup to cover (c). The other conditions need explicit handling.

9. **Migration ordering**: this workflow adds default_runtime to
   workspaces. The v4 workflow also adds tables. Both migrations must
   coexist without conflict. Ensure the migration file NAMES are
   sequential (v4 is N, v6 is N+1) so drizzle applies them in order.
   The implementer should check the existing migration numbers and
   pick a number strictly greater than any existing worker migration.

10. **\`agent-relay worker\` command version compatibility**: the copyable
    command assumes the user has a recent agent-relay CLI. If they have
    an old version that doesn't support the worker subcommand, the
    command will fail with "unknown command". The UI should mention a
    minimum CLI version in small print: "Requires agent-relay CLI vX.Y.Z
    or later."

Revise the plan with these. End with REFLECTION_COMPLETE.`,
      verification: { type: 'output_contains', value: 'REFLECTION_COMPLETE' },
    })

    // ─── Phase 4: Parallel implementation ──────────────────────────────

    .step('implement-api', {
      agent: 'impl-api',
      dependsOn: ['reflect'],
      task: `Implement the API + DB side of worker onboarding.

Plan:
{{steps.plan.output}}

Reflection (overrides):
{{steps.reflect.output}}

Create:
- packages/web/app/api/v1/workers/enrollment-tokens/route.ts
- packages/web/app/api/v1/workspaces/[workspaceId]/runtime/route.ts  (GET + PUT)
- packages/web/lib/workers/onboarding.ts  (buildRegisterCommand, buildStartCommand)
- packages/web/drizzle/migrations/NNNN_workspace_default_runtime.sql  (NNNN strictly greater than v4's worker migration)

Modify:
- packages/web/drizzle/schema/workspaces.ts  (add default_runtime JSONB nullable column)

Hard rules:
1. enrollment-tokens endpoint:
   - Requires user session + workspace admin check (use the same helper existing admin-only routes use; if none, require workspace ownership)
   - Rate limit 20/hour per user
   - Calls mintEnrollmentToken from v4's packages/web/lib/workers/tokens.ts
   - Response includes registerCommand + startCommand built via onboarding.ts helpers
   - Never logs the token
2. workspaces/[workspaceId]/runtime endpoint:
   - GET: returns { id: 'daytona' } if default_runtime is NULL, otherwise returns the stored JSON
   - PUT: validates the payload shape, and if id === 'worker', verifies config.workerId belongs to the workspace
   - PUT requires workspace admin
3. onboarding.ts helpers: pure functions, no side effects, deterministic output. Include a MIN_CLI_VERSION constant that the UI can reference.
4. Migration SQL is one-liner: ALTER TABLE workspaces ADD COLUMN default_runtime JSONB;
5. Do not touch packages/core/**. Do not touch the v4 register or worker management endpoints.

Do not run build or migration commands.`,
      verification: { type: 'file_exists', value: 'packages/web/app/api/v1/workers/enrollment-tokens/route.ts' },
    })

    .step('implement-ui', {
      agent: 'impl-ui',
      dependsOn: ['reflect'],
      task: `Implement the web UI pages and components for worker onboarding.

Plan:
{{steps.plan.output}}

Reflection (overrides):
{{steps.reflect.output}}

Create:
- packages/web/app/workspaces/[workspaceId]/runtimes/page.tsx            (runtimes landing)
- packages/web/app/workspaces/[workspaceId]/runtimes/workers/page.tsx    (workers list)
- packages/web/app/workspaces/[workspaceId]/runtimes/workers/new/page.tsx (new worker form)
- packages/web/components/workers/WorkerStatusBadge.tsx
- packages/web/components/workers/CopyableCommand.tsx                    (client component)
- packages/web/components/workers/WorkersTable.tsx
- packages/web/components/workers/NewWorkerForm.tsx                      (client component)
- packages/web/components/workers/EnrollmentSuccess.tsx                  (client component)

Hard rules:
1. Match the existing Next.js App Router + Tailwind + component library style. Look at a neighboring workspace settings page as a template.
2. Server components by default. Only mark "use client" where actually needed (forms with state, copy buttons, polling regions).
3. CopyableCommand uses textContent to render, not dangerouslySetInnerHTML. The copy button uses navigator.clipboard.writeText.
4. EnrollmentSuccess shows a warning banner: "This token is shown only once — copy it now." The token is rendered inside a code block, not as a query string or href.
5. NewWorkerForm submits to POST /api/v1/workers/enrollment-tokens and on success renders EnrollmentSuccess with the returned commands.
6. EnrollmentSuccess has a polling region that GETs /api/v1/workers?workspaceId=... every 3 seconds, filters for a worker with the submitted name, and stops when:
   (a) worker appears with status='online' → show success card
   (b) 5 minutes elapsed without success → show timeout message with "Retry" and "Cancel" buttons
   (c) user clicks Cancel → navigate back to the workers list
   (d) component unmounts → useEffect cleanup cancels the interval
7. WorkersTable row actions: View (link), Revoke (DELETE /api/v1/workers/:id with confirm dialog), Set as Default (PUT /api/v1/workspaces/:id/runtime).
8. Runtimes landing page shows:
   - Current default runtime (reads GET /api/v1/workspaces/:id/runtime)
   - "Change default" action → opens a picker with: Daytona, plus each online worker in the workspace
   - If the currently-selected default worker is offline, show an amber warning: "Default worker is offline. New workflows will queue for up to 10 minutes."
9. Minimum CLI version note: in the "new worker" page, show a small hint line near the copyable commands: "Requires agent-relay CLI {MIN_CLI_VERSION} or later." Read MIN_CLI_VERSION from the onboarding.ts helper (server component can import it directly).
10. Do not touch API routes or DB schema. Do not touch packages/core/**.

Do not run build commands.`,
      verification: { type: 'file_exists', value: 'packages/web/app/workspaces/[workspaceId]/runtimes/workers/new/page.tsx' },
    })

    // ─── Phase 5: Self-reviews (parallel) ──────────────────────────────

    .step('self-review-api', {
      agent: 'impl-api',
      dependsOn: ['implement-api'],
      task: `Self-review the API side.

Checklist:
1. enrollment-tokens route: user session + workspace admin gate is present.
2. enrollment-tokens route: rate limit enforced (20/hour per user).
3. enrollment-tokens route: token value is never logged.
4. enrollment-tokens route: response includes registerCommand + startCommand.
5. workspaces/runtime PUT: validates runtime.id === 'worker' → config.workerId must exist in this workspace.
6. workspaces/runtime GET: returns Daytona default when column is NULL.
7. onboarding.ts: pure functions, deterministic, exports MIN_CLI_VERSION.
8. Migration file NNNN is strictly greater than any v4 worker migration number.
9. No 5xx leaks stack traces.
10. All imports use .js extensions.

Fix any issues by editing on disk. End with SELF_REVIEW_COMPLETE.`,
      verification: { type: 'output_contains', value: 'SELF_REVIEW_COMPLETE' },
    })

    .step('self-review-ui', {
      agent: 'impl-ui',
      dependsOn: ['implement-ui'],
      task: `Self-review the UI.

Checklist:
1. Server/client component split: only state-bearing components are "use client".
2. CopyableCommand uses textContent + navigator.clipboard.writeText. NOT dangerouslySetInnerHTML.
3. EnrollmentSuccess has the "shown only once" warning banner.
4. Polling region has all 4 stop conditions (online, timeout, cancel, unmount).
5. Polling region cleans up interval in useEffect cleanup.
6. WorkersTable row actions: View, Revoke (with confirm), Set as Default.
7. Runtimes landing page reads current default, shows picker, warns if default worker is offline.
8. New worker page shows the MIN_CLI_VERSION hint.
9. Tailwind classes match the rest of the app (pick a neighboring page as reference).
10. No stray console.log. No TODO markers.

Fix any issues by editing on disk. End with SELF_REVIEW_COMPLETE.`,
      verification: { type: 'output_contains', value: 'SELF_REVIEW_COMPLETE' },
    })

    // ─── Phase 6: Deterministic verification ───────────────────────────

    .step('verify-build', {
      type: 'deterministic',
      dependsOn: ['self-review-api', 'self-review-ui'],
      command: [
        'cd packages/web && npx tsc --noEmit 2>&1 | tee /tmp/runtime-v6-tsc.log | head -200',
        'echo',
        'grep -c "error TS" /tmp/runtime-v6-tsc.log || echo 0',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })

    .step('verify-ui-files', {
      type: 'deterministic',
      dependsOn: ['self-review-ui'],
      command: [
        'for f in \\',
        '  packages/web/app/workspaces/\\[workspaceId\\]/runtimes/page.tsx \\',
        '  packages/web/app/workspaces/\\[workspaceId\\]/runtimes/workers/page.tsx \\',
        '  packages/web/app/workspaces/\\[workspaceId\\]/runtimes/workers/new/page.tsx \\',
        '  packages/web/components/workers/CopyableCommand.tsx \\',
        '  packages/web/components/workers/NewWorkerForm.tsx \\',
        '  packages/web/components/workers/EnrollmentSuccess.tsx \\',
        '  packages/web/components/workers/WorkersTable.tsx \\',
        '  packages/web/components/workers/WorkerStatusBadge.tsx; do',
        '  test -f "$f" && echo "ok: $f" || { echo "MISSING: $f"; exit 1; }',
        'done',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    .step('verify-api-files', {
      type: 'deterministic',
      dependsOn: ['self-review-api'],
      command: [
        'for f in \\',
        '  packages/web/app/api/v1/workers/enrollment-tokens/route.ts \\',
        '  packages/web/app/api/v1/workspaces/\\[workspaceId\\]/runtime/route.ts \\',
        '  packages/web/lib/workers/onboarding.ts; do',
        '  test -f "$f" && echo "ok: $f" || { echo "MISSING: $f"; exit 1; }',
        'done',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    .step('verify-no-dangerously-set', {
      type: 'deterministic',
      dependsOn: ['self-review-ui'],
      command: 'grep -rn "dangerouslySetInnerHTML" packages/web/components/workers/ 2>&1 && { echo "FOUND dangerouslySetInnerHTML in worker components"; exit 1; } || echo "clean"',
      captureOutput: true,
      failOnError: true,
    })

    .step('fix-build', {
      agent: 'impl-api',
      dependsOn: ['verify-build', 'verify-ui-files', 'verify-api-files', 'verify-no-dangerously-set'],
      task: `Verification output:

tsc:
{{steps.verify-build.output}}

UI files:
{{steps.verify-ui-files.output}}

API files:
{{steps.verify-api-files.output}}

dangerouslySetInnerHTML check:
{{steps.verify-no-dangerously-set.output}}

If any tsc errors exist, fix them on disk. If files are missing, create them. If dangerouslySetInnerHTML was found in the worker components, replace it with textContent.

If clean, output NO_FIX_NEEDED.`,
      verification: { type: 'exit_code' },
    })

    .step('re-verify-build', {
      type: 'deterministic',
      dependsOn: ['fix-build'],
      command: 'cd packages/web && npx tsc --noEmit 2>&1',
      captureOutput: true,
      failOnError: true,
    })

    // ─── Phase 7: Peer review ──────────────────────────────────────────

    .step('peer-review', {
      agent: 'reviewer',
      dependsOn: ['re-verify-build'],
      task: `Peer-review the worker onboarding UI + API.

Read:
- packages/web/app/api/v1/workers/enrollment-tokens/route.ts
- packages/web/app/api/v1/workspaces/[workspaceId]/runtime/route.ts
- packages/web/lib/workers/onboarding.ts
- packages/web/drizzle/schema/workspaces.ts (diff only)
- packages/web/drizzle/migrations/*workspace_default_runtime*
- packages/web/app/workspaces/[workspaceId]/runtimes/**/page.tsx
- packages/web/components/workers/*.tsx

Review for:

## Security
1. Enrollment token endpoint requires user session + workspace admin.
2. Rate limited to 20/hour per user.
3. Token is never logged.
4. UI shows "token shown only once" warning.
5. CopyableCommand uses textContent, not dangerouslySetInnerHTML.
6. Workspace runtime PUT validates admin role + worker ownership.

## UX correctness
7. Polling region has all 4 stop conditions (online / timeout / cancel / unmount).
8. Offline default worker triggers a visible warning on the runtimes landing.
9. MIN_CLI_VERSION hint is shown on the new worker page.
10. Token display has a copy button that actually works (navigator.clipboard.writeText, not a hacky execCommand).

## Code quality
11. Server components by default, client components only where state is needed.
12. Components follow the existing Tailwind style.
13. No stale console.log or TODO markers.
14. Migration number is sequential relative to v4's worker migration.

## API ergonomics
15. enrollment-tokens response shape: { token, expiresAt, registerCommand, startCommand }.
16. GET /workspaces/:id/runtime returns Daytona default when NULL.
17. PUT /workspaces/:id/runtime is idempotent (same payload twice = same result).

Verdict: APPROVED or CHANGES_REQUESTED with grouped bullets.

End with REVIEW_COMPLETE.`,
      verification: { type: 'output_contains', value: 'REVIEW_COMPLETE' },
    })

    .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  console.log('Result:', result.status);
}

main().catch(console.error);
