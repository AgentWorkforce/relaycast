# Ricky Cloud Auto-Fix v1 Spec

**Status:** draft, implementation-ready after owner review.
**Owner:** Cloud + Ricky.
**Last updated:** 2026-05-03.
**Primary repos:** `../cloud`, `../ricky`, `../workforce`.
**Related local behavior:** `../ricky/src/local/auto-fix-loop.ts`, `../ricky/src/product/generation/workforce-persona-repairer.ts`.

## 1. Problem Statement

Ricky works well locally because it can run an Agent Relay workflow, collect deterministic failure evidence, classify the failure, repair the workflow artifact, and rerun from the failed step. Cloud workflow runs currently have the raw pieces of that loop: run launch, connected agent credentials, credential proxy fallback, run status, logs, step metadata, patches, and worker dispatch. They do not yet expose Ricky as a first-class cloud supervisor that keeps trying until the workflow is actually proven or truthfully escalated.

The v1 goal is to make a cloud workflow run behave like local Ricky:

1. Launch the workflow in cloud.
2. Monitor until terminal or blocked.
3. If it fails, diagnose with Ricky evidence.
4. Ascertain which subscription-backed agents are available for the workspace and user.
5. Prefer a Workforce persona repair agent when one is available.
6. Fall back to a non-persona Ricky repair agent over OpenRouter when no Claude, OpenCode, or Codex subscription path is usable.
7. Apply the repaired workflow artifact in an isolated run copy.
8. Rerun with `previousRunId` and `startFrom`.
9. Stop only on success, an explicit human gate, cancellation, or exhausted attempts.

## 2. Goals

- Provide a managed Ricky supervisor for cloud workflow runs without breaking the existing `/api/v1/workflows/run` API.
- Use existing cloud records for workspace, user, workflow run, cloud agent, connected CLI credential, worker assignment, S3 artifact, and Relayfile linkage whenever possible.
- Discover usable execution agents from the user's subscriptions and connected cloud agents: Claude, OpenCode, Codex.
- Route repair through a Workforce persona agent when available and matched to the failure.
- Provide a persona-free Ricky repair fallback using the cloud credential proxy and OpenRouter.
- Preserve the 80-to-100 workflow standard: deterministic proof after each repair and a hard final gate.
- Make every auto-fix attempt auditable, resumable, cancelable, and inspectable from CLI, web, and v2 Slack.

## 3. Non-Goals

- v1 does not make Ricky a chat assistant. Slack lives in v2.
- v1 does not mutate a user's Git branch or open PRs by default. It repairs an isolated workflow-run copy and exposes patches/artifacts for review.
- v1 does not require Workforce persona availability. The OpenRouter-backed Ricky fallback is mandatory.
- v1 does not replace existing workflow runs, worker dispatch, Daytona, E2B, or BYOI runtimes.
- v1 does not guarantee every failure is auto-fixable. Human gates are first-class terminal or paused states.

## 4. Existing Components To Reuse

### Cloud

- `packages/web/app/api/v1/workflows/run/route.ts` launches workflow runs, provisions Relay workspace context, mints S3 and cloud API credentials, mounts CLI credentials, and supports `resume`, `startFrom`, and `previousRunId`.
- `packages/web/lib/workflows.ts` owns `workflowStore` create/get/update/list and step persistence.
- `packages/core/src/db/schema.ts` already has `workflowRuns`, `workflowSteps`, `sessionEvents`, `cloudAgents`, `cloudAgentAuthSessions`, `workers`, and `workAssignments`.
- `packages/core/src/auth/cli-credentials.ts` can list connected providers and map `claude`, `codex`, `opencode` to credential providers.
- `packages/core/src/auth/proxy-token.ts` already gates credential proxy use and currently supports OpenRouter as the deployed proxy provider.
- `packages/web/app/api/v1/workflows/runs/[runId]/events/route.ts` stores run events and is the right source for timeline reconstruction.
- `packages/web/app/api/v1/workflows/runs/[runId]/patch/route.ts` exposes sandbox changes after terminal runs.

### Ricky

- `runWithAutoFix()` defines the local attempt loop and retry semantics.
- `localResponseToWorkflowRunEvidence()` and the shared evidence models define the shape that diagnosis expects.
- `debugWorkflowRun()` and the failure classifier define the repair mode.
- `repairWorkflowWithWorkforcePersona()` dispatches to Workforce when a matching persona can handle semantic workflow repairs.
- The deterministic fallback in `auto-fix-loop.ts` covers simple artifact mismatches when persona repair is not available.

### Workforce

- Workforce persona availability is not a cloud credential provider. It is a runtime/persona selection capability. v1 treats Workforce as an optional repair target selected after run evidence exists.

## 5. Architecture

Add a cloud-side Ricky supervisor as an additive layer around existing workflow runs.

```text
Client / CLI / Dashboard
        |
        v
POST /api/v1/ricky/runs
        |
        v
RickyRunSupervisor
        |
        +--> WorkflowRunLauncher -> existing /api/v1/workflows/run path
        |
        +--> RunMonitor -> workflowStore + sessionEvents + steps + logs + patch
        |
        +--> AgentAvailabilityResolver
        |       +--> cloudAgents
        |       +--> CLI credential metadata
        |       +--> credential proxy/OpenRouter readiness
        |       +--> Workforce persona resolver
        |
        +--> RickyDiagnosisAdapter -> @agentworkforce/ricky failure classifier/debugger
        |
        +--> RepairRouter
                +--> WorkforcePersonaRepairAdapter
                +--> RickyOpenRouterRepairAdapter
                +--> DeterministicRepairAdapter
                +--> HumanGateAdapter
        |
        +--> RepairedRunLauncher -> existing workflow run with startFrom/previousRunId
```

The supervisor is not an agent process itself. It is a durable state machine in the Cloud web/control plane that launches runs and delegates repair work to agents only when repair is needed.

## 6. Public API

### 6.1 Create A Ricky-Supervised Run

`POST /api/v1/ricky/runs`

Request:

```ts
interface CreateRickyRunRequest {
  workflow: string;
  fileType: "yaml" | "ts" | "py";
  sourceFileType?: "yaml" | "ts" | "py";
  workflowPath?: string;
  s3CodeKey?: string;
  runtime?: { id: string; config?: unknown };
  envSecrets?: Record<string, string>;
  autoFix?: {
    enabled?: boolean;              // default true
    maxAttempts?: number;           // default 3, max 5
    preferWorkforcePersona?: boolean; // default true
    allowOpenRouterFallback?: boolean; // default true
    requireHumanApprovalFor?: Array<
      "repo_mutation" |
      "external_side_effect" |
      "credential_change" |
      "ambiguous_repair" |
      "cost_over_budget"
    >;
  };
  notification?: {
    surface?: "none" | "webhook" | "slack"; // slack populated in v2
    webhookUrl?: string;
  };
}
```

Response:

```ts
interface CreateRickyRunResponse {
  rickyRunId: string;
  rootRunId: string;
  status: "pending" | "running";
  monitorUrl: string;
  attempts: Array<{
    attempt: number;
    workflowRunId: string;
    role: "original";
    status: "pending" | "running";
  }>;
}
```

The endpoint calls the existing workflow launcher internally rather than duplicating launch logic. It stores the returned `runId` as the root attempt.

### 6.2 Get Ricky Run

`GET /api/v1/ricky/runs/:rickyRunId`

Returns state, attempts, selected repair agents, gates, links to workflow runs, latest diagnosis, and final outcome.

### 6.3 Cancel Ricky Run

`POST /api/v1/ricky/runs/:rickyRunId/cancel`

Cancels the supervisor and the currently active workflow run if possible. Historical attempts remain readable.

### 6.4 Resolve Human Gate

`POST /api/v1/ricky/runs/:rickyRunId/gates/:gateId/resolve`

Request:

```ts
type GateResolution =
  | { decision: "approve"; comment?: string }
  | { decision: "deny"; comment?: string }
  | { decision: "edit"; instruction: string; comment?: string };
```

Approve continues the repair or rerun. Deny ends the Ricky run as `human_denied`. Edit re-enters repair with the human instruction appended to the repair context.

## 7. Data Model

Add tables in `packages/core/src/db/schema.ts` and matching Drizzle migrations.

### 7.1 `ricky_runs`

```ts
{
  id: uuid primary key,
  organizationId: uuid not null,
  workspaceId: uuid not null,
  userId: uuid not null,
  rootWorkflowRunId: uuid not null,
  activeWorkflowRunId: uuid,
  status: text not null,
  maxAttempts: integer not null,
  currentAttempt: integer not null,
  sourceWorkflowPath: text,
  sourceFileType: text not null,
  runtimeJson: jsonb,
  autoFixPolicyJson: jsonb not null,
  selectedAgentJson: jsonb,
  latestDiagnosisJson: jsonb,
  finalResultJson: jsonb,
  error: text,
  createdAt: timestamptz not null,
  updatedAt: timestamptz not null,
  completedAt: timestamptz
}
```

### 7.2 `ricky_attempts`

```ts
{
  id: uuid primary key,
  rickyRunId: uuid not null,
  attempt: integer not null,
  workflowRunId: uuid not null,
  previousWorkflowRunId: uuid,
  startFromStep: text,
  role: text not null, // original | repaired_rerun
  repairMode: text,    // workforce_persona | ricky_openrouter | deterministic | none
  repairAgentJson: jsonb,
  diagnosisJson: jsonb,
  repairSummary: text,
  repairedWorkflowPath: text,
  repairedWorkflowDigest: text,
  status: text not null,
  error: text,
  createdAt: timestamptz not null,
  updatedAt: timestamptz not null,
  completedAt: timestamptz
}
```

### 7.3 `ricky_human_gates`

```ts
{
  id: uuid primary key,
  rickyRunId: uuid not null,
  attemptId: uuid not null,
  workflowRunId: uuid,
  gateType: text not null,
  reason: text not null,
  prompt: text not null,
  proposedActionJson: jsonb,
  status: text not null, // open | approved | denied | edited | expired | canceled
  requestedByAgentJson: jsonb,
  resolvedByUserId: uuid,
  resolutionJson: jsonb,
  expiresAt: timestamptz,
  createdAt: timestamptz not null,
  resolvedAt: timestamptz
}
```

### 7.4 `ricky_run_events`

Use `sessionEvents` if possible. If a Ricky-specific event stream is easier for dashboard queries, add this table:

```ts
{
  id: uuid primary key,
  rickyRunId: uuid not null,
  sequence: integer not null,
  eventType: text not null,
  payload: jsonb not null,
  createdAt: timestamptz not null
}
```

Events should include `ricky.started`, `workflow.launched`, `workflow.terminal`, `diagnosis.completed`, `agent.availability.resolved`, `repair.started`, `repair.completed`, `gate.opened`, `gate.resolved`, `rerun.launched`, `ricky.completed`, and `ricky.failed`.

## 8. State Machine

```text
pending
  -> launching_original
  -> monitoring
  -> succeeded
  -> diagnosing
  -> selecting_repair_agent
  -> repairing
  -> awaiting_human_gate
  -> launching_rerun
  -> monitoring
  -> exhausted
  -> failed
  -> canceled
```

Terminal statuses:

- `succeeded`: a workflow attempt completed and final deterministic gates passed.
- `exhausted`: max attempts reached after failed repair/rerun.
- `failed`: supervisor infrastructure failed or no truthful path exists.
- `human_denied`: user denied a required gate.
- `canceled`: user canceled.

Paused statuses:

- `awaiting_human_gate`: the next action requires approval, missing input, or credential connection.

## 9. Agent Availability Resolution

Agent availability is an evidence-producing step, not a boolean.

```ts
interface AgentAvailability {
  checkedAt: string;
  workspaceId: string;
  userId: string;
  requestedClis: string[];
  subscriptionAgents: Array<{
    cli: "claude" | "opencode" | "codex";
    provider: "anthropic" | "opencode" | "openai";
    source: "cloud_agents" | "cli_credentials" | "worker";
    status: "usable" | "expired" | "missing" | "unhealthy" | "unsupported";
    credentialExpiresAt?: string;
    lastAuthenticatedAt?: string;
    reason?: string;
  }>;
  workforcePersona?: {
    status: "usable" | "missing" | "unmatched" | "unhealthy";
    personaId?: string;
    tier?: string;
    harness?: string;
    model?: string;
    selectedIntent?: string;
    reason?: string;
  };
  openRouterFallback: {
    status: "usable" | "missing" | "disabled" | "unhealthy";
    provider: "openrouter";
    model: string; // configured default, e.g. openrouter/auto
    reason?: string;
  };
}
```

Resolver order:

1. Parse the workflow for declared agent CLIs. YAML uses the existing `getAllProviders()` path. TypeScript/Python use the existing script CLI extractor plus a fallback to all connected providers.
2. Query `cloudAgents` for `harness in ('claude','opencode','codex')`, same workspace/user, `status='connected'`, non-exhausted refresh, and non-expired credentials.
3. Query encrypted CLI credential metadata via `listConnectedProviders()` for `anthropic`, `openai`, and `opencode`.
4. Check runtime support: target runtime image must have required CLIs installed or be able to use the credential proxy.
5. Check Workforce persona resolver for Ricky workflow repair intents. This is separate from CLI subscriptions.
6. Check OpenRouter fallback readiness: credential proxy URL, JWT secret, and OpenRouter upstream key must be configured and policy must allow fallback.

Selection rules:

1. If a Workforce persona is usable and `preferWorkforcePersona` is true, use it for semantic workflow artifact repairs.
2. Else if the failed workflow's declared CLI has a usable subscription-backed agent, use the closest matching agent for repair.
3. Else if OpenRouter fallback is usable, use `RickyOpenRouterRepairAdapter`.
4. Else open a human gate with `missing_agent_capacity`.

## 10. Failure Evidence

The supervisor builds `WorkflowRunEvidence` from cloud data:

- `workflowRuns.status`, `result`, `error`, `fileType`, `workflow`.
- `workflowSteps` ordered by start time.
- `sessionEvents` ordered by sequence.
- S3 logs from `/runs/:runId/logs` or direct storage access.
- Patch from `/runs/:runId/patch` when terminal.
- Runtime metadata: runtime id, sandbox id, worker assignment id, relay workspace id.
- Retry metadata: previous run id, start-from step, attempt number.

Evidence must be persisted with the attempt or referenced by object key. Repair agents must receive evidence snapshots, not live mutable run state.

## 11. Repair Router

```ts
interface RepairDecision {
  mode:
    | "workforce_persona"
    | "subscription_agent"
    | "ricky_openrouter"
    | "deterministic"
    | "human_gate";
  reason: string;
  selectedAgent?: Record<string, unknown>;
  gate?: {
    gateType: string;
    prompt: string;
    proposedAction?: unknown;
  };
}
```

Routing inputs:

- Failure classification.
- Debugger recommendation.
- Agent availability.
- Auto-fix policy.
- Attempt count.
- Whether a safe workflow artifact target exists.
- Whether the proposed repair has external side effects.

Routing rules:

1. Missing credentials, missing required repo secrets, destructive repo operations, production deploys, and ambiguous fixes require a human gate.
2. Workflow artifact syntax errors, wrong artifact paths, missing deterministic gates, broken step dependencies, and semantic workflow contract failures are repairable.
3. Workforce persona repair is preferred for semantic workflow design failures.
4. OpenRouter Ricky repair is allowed only for workflow artifact repair and diagnosis. It cannot receive arbitrary user secrets beyond scoped run evidence.
5. Deterministic repair is allowed only for known bounded cases, such as expected file path mismatches, missing artifact directories, and start-from metadata repairs.

## 12. Repair Application

The repaired workflow must be applied in an isolated run copy.

For TypeScript/Python source-sync runs:

1. Download or mount the original uploaded code tarball.
2. Apply the repaired workflow content at `workflowPath`.
3. Write a new code tarball to S3 under the Ricky attempt prefix.
4. Launch `/api/v1/workflows/run` with new `s3CodeKey`, same `workflowPath`, `previousRunId`, and `startFrom`.

For inline workflow runs:

1. Replace the submitted workflow source in memory.
2. Launch `/api/v1/workflows/run` with the repaired `workflow`.
3. Preserve the original root workflow in `ricky_runs` for audit.

For YAML workflows:

1. Repair the YAML or generated JSON config.
2. Validate parseability before launch.
3. Preserve comments only when the repair adapter returns YAML source; otherwise accept normalized YAML.

Every repair result stores:

- Full repaired artifact content or S3 key.
- Digest.
- Summary.
- Selected agent.
- Safety classification.
- Resume plan.

## 13. Rerun Semantics

The rerun must pass:

- `previousRunId`: immediate failed attempt.
- `startFrom`: failed step when known.
- `retryOfRunId`: root failed run when the launcher supports it.
- `RICKY_RUN_ID`, `RICKY_ATTEMPT`, and `RICKY_REPAIR_MODE` as non-reserved supervisor metadata, not user env secrets.

The existing workflow launch API already accepts `previousRunId` and `startFrom`; v1 should reuse that.

## 14. Human Gates

Human gates are not errors. They are honest pauses.

Gate types:

- `missing_credentials`: user must connect Claude, Codex, OpenCode, or enable OpenRouter fallback.
- `missing_secret`: workflow needs an env secret not available in cloud.
- `approval_required`: repair proposes an external side effect.
- `ambiguous_repair`: multiple plausible repairs exist.
- `cost_over_budget`: repair/rerun would exceed configured budget.
- `unsafe_patch`: repair changes files outside the allowed workflow artifact scope.
- `max_attempts_reached`: Ricky can explain the remaining blocker but should not keep looping.

Gate prompt must include:

- What failed.
- What Ricky tried.
- What Ricky wants to do next.
- The exact file or action affected.
- Approve, deny, or edit options.

## 15. Security And Isolation

- Do not expose raw CLI credential JSON to Ricky repair prompts.
- OpenRouter fallback receives only redacted evidence and workflow artifact content.
- Repair agents cannot commit, push, open PRs, or mutate canonical repo state in v1.
- S3 attempt artifacts are namespaced by user, run, and attempt.
- Human gate approval requires the same organization/workspace access as the run.
- All supervisor API tokens need `workflow:runs:read`; gate resolution needs session auth or an explicit future `ricky:gates:write` scope.
- Credential proxy tokens for OpenRouter are short-lived and budget-limited.

## 16. Dashboard And CLI Surface

Dashboard additions:

- A Ricky run detail page that groups attempts under one root run.
- Agent availability panel: Claude, Codex, OpenCode, Workforce persona, OpenRouter fallback.
- Auto-fix timeline with diagnosis and repair summaries.
- Human gate cards.
- Links to each underlying workflow run, logs, steps, patch, and events.

CLI additions:

```bash
agent-relay cloud run workflow.ts --ricky --auto-fix
agent-relay cloud ricky status <ricky-run-id>
agent-relay cloud ricky approve <ricky-run-id> <gate-id>
agent-relay cloud ricky deny <ricky-run-id> <gate-id>
```

`ricky cloud run` can be added later as a friendlier alias, but v1 should not require installing the Ricky CLI to use the cloud feature.

## 17. Implementation Plan

### Phase 1: Supervisor Read Model

- Add DB tables and migrations.
- Add `packages/web/lib/ricky/run-supervisor.ts`.
- Add evidence builder from `workflowStore`, `workflowSteps`, `sessionEvents`, logs, and patch.
- Add `GET /api/v1/ricky/runs/:id`.

### Phase 2: Launch And Monitor

- Add `POST /api/v1/ricky/runs`.
- Launch original workflow through existing workflow launcher.
- Add polling or event-driven monitor. Polling every 10-30 seconds is acceptable for v1; event-driven callback can replace it later.
- Persist events.

### Phase 3: Agent Availability

- Add `AgentAvailabilityResolver`.
- Test cloud agent, CLI credential metadata, runtime support, Workforce persona resolver, and OpenRouter readiness.
- Persist selected availability snapshot per attempt.

### Phase 4: Diagnosis And Repair

- Extract Ricky diagnosis into an importable package or cloud adapter.
- Add repair router.
- Add Workforce persona repair adapter.
- Add OpenRouter Ricky repair adapter.
- Add deterministic repair adapter for safe known cases.

### Phase 5: Rerun Loop

- Apply repaired workflow to an isolated copy.
- Launch rerun with `previousRunId` and `startFrom`.
- Enforce max attempts and backoff.
- Persist final result.

### Phase 6: Human Gates

- Add gate table and endpoints.
- Add gate creation from repair router.
- Resume supervisor after approval or edit.

### Phase 7: UI And CLI

- Add dashboard Ricky run view.
- Add CLI flags and status commands.
- Add docs and runbooks.

## 18. Validation Strategy

Unit tests:

- Agent availability resolver covers usable, expired, missing, and fallback cases.
- Evidence builder produces Ricky-compatible evidence from cloud rows.
- Repair router selects Workforce persona before OpenRouter when both are usable.
- Repair router falls back to OpenRouter when no subscription-backed agent is usable.
- Human gate creation fires for unsafe repairs.

Integration tests:

- PGlite-backed DB tests for `ricky_runs`, `ricky_attempts`, and gates.
- Mock workflow launcher returns failed root run, then successful repaired run.
- Mock Workforce persona returns repaired artifact.
- Mock OpenRouter repair path works without Workforce persona.
- Max attempts produces `exhausted`.

End-to-end proof workflows:

- Broken deterministic artifact path: Ricky repairs and reruns successfully.
- Broken semantic workflow contract: Workforce persona repairs when available.
- No Claude/Codex/OpenCode available: OpenRouter Ricky repair succeeds.
- Missing secret: Ricky opens a human gate.
- Unsafe proposed action: Ricky opens an approval gate and resumes after approval.

Required commands before merge:

```bash
npm run web:drizzle-journal:test
npm run orchestrator:test
npx tsx --test tests/ricky/*.test.ts
```

## 19. Acceptance Criteria

- A user can start a cloud workflow with Ricky auto-fix enabled from CLI or API.
- The first failed run is captured as a root attempt.
- Ricky diagnoses the failed cloud run from cloud evidence.
- The supervisor records which Claude, OpenCode, Codex, Workforce, and OpenRouter paths were checked.
- Workforce persona repair is used when available.
- OpenRouter Ricky repair is used when no subscription-backed repair agent is available and fallback is enabled.
- Repaired attempts use `previousRunId` and `startFrom` when possible.
- The system stops with a truthful status: succeeded, exhausted, failed, canceled, or awaiting human gate.
- No raw provider credentials appear in repair prompts, logs, or event payloads.

## 20. Open Questions

- Should the v1 CLI entrypoint live under `agent-relay cloud run --ricky` only, or should `ricky cloud run` ship in the Ricky package at the same time?
- Should OpenRouter fallback default to `openrouter/auto` or a Cloud-configured explicit model alias?
- Should the dashboard show repair artifact diffs inline in v1, or only link to patch/artifact download?
- Should worker-dispatched runs support Ricky auto-fix in the first slice, or should v1.0 start with sandbox-dispatched runs and add worker parity in v1.1?
