// workflows/generated/ricky-ricky-cloud-auto-fix-v1-spec-status-draft-implem.ts
import { workflow } from '@relayflows/core';

const WORKFLOW_NAME = 'ricky-ricky-cloud-auto-fix-v1-spec-status-draft-implem';
const CHANNEL = 'wf-ricky-cloud-autofix-v1-impl';
const CONTRACT_MARKER = 'IMPLEMENTATION_WORKFLOW_CONTRACT';
const PLAN_ARTIFACT = 'docs/ricky/ricky-cloud-autofix-v1-plan.md';
const ROUTER_STATE_ARTIFACT = 'artifacts/ricky/skill-router-state.txt';
const ROUTER_STATE_SUMMARY = 'artifacts/ricky/skill-router-state-summary.txt';
const OUTPUT_MANIFEST = 'artifacts/ricky/output-manifest.txt';
const FINAL_DIFF_FILES = 'artifacts/ricky/final-diff-files.txt';
const HARD_VALIDATION_ARTIFACT = 'artifacts/ricky/hard-validation.txt';
const FINAL_SIGNOFF_ARTIFACT = 'artifacts/ricky/final-signoff.txt';
const PHASE_1_OWNER_DECISION_ARTIFACT = 'artifacts/ricky/phase-1-owner-decision.txt';
const PHASE_2_OWNER_DECISION_ARTIFACT = 'artifacts/ricky/phase-2-owner-decision.txt';
const PHASE_1_SCOPE_ARTIFACT = 'artifacts/ricky/phase-1-scope.txt';
const IMPLEMENTATION_PHASE_1_FILES = 'artifacts/ricky/implementation-phase-1-files.txt';
const IMPLEMENTATION_FILES = 'artifacts/ricky/implementation-files.txt';
const RESUME_MARKER_ARTIFACT = 'artifacts/ricky/resume-marker.txt';
const IMPLEMENT_TESTS_SCOPE_ARTIFACT = 'artifacts/ricky/implement-tests-scope.txt';
const IMPLEMENT_TESTS_DECISION_ARTIFACT = 'artifacts/ricky/implement-tests-owner-decision.txt';
const IMPLEMENT_TESTS_CONTINUATION_ARTIFACT =
  '.workflow-artifacts/ricky-auto-fix/implement-tests-timeout-continuation.md';
const REVIEW_LOOP_DECISION_ARTIFACT = 'artifacts/ricky/review-and-fix-loop-owner-decision.txt';
const REVIEW_LOOP_SCOPE_ARTIFACT = 'artifacts/ricky/review-and-fix-loop-scope.txt';
const REVIEW_LOOP_CONTINUATION_ARTIFACT = '.workflow-artifacts/ricky-auto-fix/review-and-fix-loop-timeout-continuation.md';

const PLAN_STEP_TIMEOUT_MS = 180_000;
const IMPLEMENTATION_PHASE_1_TIMEOUT_MS = 900_000;
const IMPLEMENTATION_PHASE_2_TIMEOUT_MS = 600_000;
const TEST_STEP_TIMEOUT_MS = 240_000;
const REVIEW_STEP_TIMEOUT_MS = 300_000;
const TESTS_CONTINUATION_TIMEOUT_MS = 120_000;
const REVIEW_LOOP_CONTINUATION_TIMEOUT_MS = 120_000;
const SIGNOFF_TIMEOUT_MS = 120_000;

async function main() {
  const result = await workflow(WORKFLOW_NAME)
    .description('Implement Ricky Cloud Auto-Fix v1 supervisor end-to-end with deterministic evidence, repair/rerun semantics, and hard validation')
    .pattern('dag')
    .channel(CHANNEL)
    .maxConcurrency(1)
    .timeout(5_400_000)

    .agent('lead', {
      cli: 'codex',
      role: 'Owns architecture gates, acceptance checks, and final signoff',
      preset: 'lead',
      retries: 1,
      maxTokens: 12_000,
    })
    .agent('impl', {
      cli: 'codex',
      role: 'Implements API, supervisor, adapters, and migration wiring',
      preset: 'worker',
      retries: 1,
      maxTokens: 64_000,
    })
    .agent('tests', {
      cli: 'codex',
      role: 'Adds and fixes tests for resolver, evidence builder, repair router, and run loop',
      preset: 'worker',
      retries: 1,
      maxTokens: 14_000,
    })

    .step('preflight', {
      type: 'deterministic',
      command: [
        'set -e',
        'git rev-parse --is-inside-work-tree >/dev/null',
        'test -f specs/ricky-cloud-autofix-v1.md',
        'test -f .agents/skills/writing-agent-relay-workflows/SKILL.md',
        'test -f packages/router/index.ts',
        'mkdir -p artifacts/ricky docs/ricky',
        'mkdir -p .workflow-artifacts/ricky-auto-fix',
        `rm -f ${PHASE_1_OWNER_DECISION_ARTIFACT} ${PHASE_2_OWNER_DECISION_ARTIFACT} ${PHASE_1_SCOPE_ARTIFACT} ${RESUME_MARKER_ARTIFACT} ${IMPLEMENT_TESTS_SCOPE_ARTIFACT} ${IMPLEMENT_TESTS_DECISION_ARTIFACT} ${IMPLEMENT_TESTS_CONTINUATION_ARTIFACT} ${REVIEW_LOOP_DECISION_ARTIFACT} ${REVIEW_LOOP_SCOPE_ARTIFACT} ${REVIEW_LOOP_CONTINUATION_ARTIFACT} ${HARD_VALIDATION_ARTIFACT} ${FINAL_SIGNOFF_ARTIFACT}`,
        'echo preflight_ok',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      timeoutMs: 120_000,
    })

    .step('read-skill-and-router-state', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: [
        'set -e',
        `echo "=== SKILL MANIFEST ===" > ${ROUTER_STATE_ARTIFACT}`,
        `sed -n "1,220p" .agents/skills/writing-agent-relay-workflows/SKILL.md >> ${ROUTER_STATE_ARTIFACT}`,
        `echo "\\n=== ROUTER STATE ===" >> ${ROUTER_STATE_ARTIFACT}`,
        `sed -n "1,260p" packages/router/index.ts >> ${ROUTER_STATE_ARTIFACT}`,
        `echo "\\n=== ROUTER TESTS ===" >> ${ROUTER_STATE_ARTIFACT}`,
        `sed -n "1,260p" tests/router.test.ts >> ${ROUTER_STATE_ARTIFACT}`,
        `echo "\\n=== OPTIONAL WORKLOAD ROUTER SNAPSHOT ===" >> ${ROUTER_STATE_ARTIFACT}`,
        `if [ -f ../workforce/packages/workload-router/src/index.ts ]; then sed -n "1,220p" ../workforce/packages/workload-router/src/index.ts >> ${ROUTER_STATE_ARTIFACT}; else echo "workload-router source not found in ../workforce (optional)." >> ${ROUTER_STATE_ARTIFACT}; fi`,
        `echo "ROUTER_STATE_FILE=${ROUTER_STATE_ARTIFACT}" > ${ROUTER_STATE_SUMMARY}`,
        `wc -l ${ROUTER_STATE_ARTIFACT} >> ${ROUTER_STATE_SUMMARY}`,
        `shasum -a 256 ${ROUTER_STATE_ARTIFACT} >> ${ROUTER_STATE_SUMMARY}`,
        'echo ROUTER_STATE_CAPTURED >> artifacts/ricky/skill-router-state-summary.txt',
        'echo router_state_captured',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      timeoutMs: 180_000,
    })

    .step('emit-minimal-plan-and-mapping', {
      agent: 'lead',
      dependsOn: ['read-skill-and-router-state'],
      task: `Write a concise implementation plan that demonstrates how a user task flows through an agent-relay-driven writing workflow, and keep it model-agnostic.

Required output file:
- ${PLAN_ARTIFACT}

The plan must include exactly these sections:
1) Steps (minimal, testable)
2) Explicit wiring steps (API, DB, supervisor, adapters)
3) Concrete task-to-workflow mapping example
4) Integration testing notes

Constraints:
- Include the literal marker ${CONTRACT_MARKER} once in the plan.
- Keep prompts and wording model-agnostic.
- Ensure compatibility with existing router/workload wiring and current APIs.
- Do not claim work as done; this is the execution plan artifact for this run.
- Keep stdout concise; do not print file contents or long transcripts.

When complete, exit successfully.`.trim(),
      verification: { type: 'exit_code' },
      timeoutMs: PLAN_STEP_TIMEOUT_MS,
      retries: 0,
    })

    .step('verify-plan-artifact', {
      type: 'deterministic',
      dependsOn: ['emit-minimal-plan-and-mapping'],
      command: [
        'set -e',
        `test -s ${PLAN_ARTIFACT}`,
        `rg -n "Steps \\(minimal, testable\\)" ${PLAN_ARTIFACT} >/dev/null`,
        `rg -n "Explicit wiring steps \\(API, DB, supervisor, adapters\\)" ${PLAN_ARTIFACT} >/dev/null`,
        `rg -n "Concrete task-to-workflow mapping example" ${PLAN_ARTIFACT} >/dev/null`,
        `rg -n "Integration testing notes" ${PLAN_ARTIFACT} >/dev/null`,
        `MARKER_COUNT=$(rg -o "${CONTRACT_MARKER}" ${PLAN_ARTIFACT} | wc -l | tr -d " ")`,
        'if [ "$MARKER_COUNT" != "1" ]; then echo "bad_marker_count:$MARKER_COUNT"; exit 1; fi',
        'echo plan_artifact_ok',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      timeoutMs: 120_000,
    })

    .step('gate-implement-supervisor-and-api-inputs', {
      type: 'deterministic',
      dependsOn: ['verify-plan-artifact'],
      command: [
        'set -e',
        `test -s ${PLAN_ARTIFACT}`,
        `test -s ${ROUTER_STATE_ARTIFACT}`,
        `echo "PHASE_1_SCOPE_CONTRACT" > ${PHASE_1_SCOPE_ARTIFACT}`,
        'echo "Phase 1 edits must include Ricky API wiring and supervisor scaffolding." >> artifacts/ricky/phase-1-scope.txt',
        'echo "All prompts and outputs must remain model-agnostic." >> artifacts/ricky/phase-1-scope.txt',
        'echo "Resume entrypoint for phase 1: implement-supervisor-and-api" >> artifacts/ricky/phase-1-scope.txt',
        'echo phase_1_input_gate_ok',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      timeoutMs: 120_000,
    })

    .step('set-resume-marker-implement-supervisor-and-api', {
      type: 'deterministic',
      dependsOn: ['gate-implement-supervisor-and-api-inputs'],
      command: [
        'set -e',
        `echo "START_FROM=implement-supervisor-and-api" > ${RESUME_MARKER_ARTIFACT}`,
        `echo "PREVIOUS_RUN_ID=<previous-run-id>" >> ${RESUME_MARKER_ARTIFACT}`,
        'echo resume_marker_written_for_implement_supervisor_and_api',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      timeoutMs: 60_000,
    })

    .step('implement-supervisor-and-api', {
      agent: 'impl',
      dependsOn: ['set-resume-marker-implement-supervisor-and-api'],
      task: `Implement Ricky Cloud Auto-Fix v1 phase 1 in this repository using specs/ricky-cloud-autofix-v1.md as the contract.

Phase 1 scope (must complete in this step):
- Add Ricky supervisor endpoints under packages/web/app/api/v1/ricky/runs (create/get/cancel/gate resolve).
- Add supervisor core wiring under packages/web/lib/ricky/* including:
  - run supervisor state machine scaffolding
  - evidence builder scaffolding from workflowRuns/workflowSteps/sessionEvents/logs/patch
  - agent availability resolver scaffolding
- Add required schema + drizzle migration updates for ricky_runs, ricky_attempts, and ricky_human_gates, including journal updates when SQL migrations are added.
- Reuse existing /api/v1/workflows/run launch path (no duplicate launcher).

Constraints:
- Keep analysis and tool usage tightly scoped to files needed for phase 1 only.
- Keep artifact edits in source files and tests; do not stop at plan-only outputs.
- Keep all prompts model-agnostic and avoid model-specific assumptions.
- Never expose raw credential JSON in prompts/logs/events.
- Keep stdout concise and avoid KEY:VALUE heading blocks in stdout.

Required machine-readable checkpoint:
- Write ${PHASE_1_OWNER_DECISION_ARTIFACT} before exit with exactly:
  OWNER_DECISION: COMPLETE
  REASON: <short reason>
  or
  OWNER_DECISION: INCOMPLETE_RETRY
  REASON: <precise blocker details>

When complete, exit successfully.`.trim(),
      verification: { type: 'exit_code' },
      timeoutMs: IMPLEMENTATION_PHASE_1_TIMEOUT_MS,
      retries: 1,
    })

    .step('gate-implement-supervisor-and-api-outcome', {
      type: 'deterministic',
      dependsOn: ['implement-supervisor-and-api'],
      command: [
        'set -e',
        `test -s ${PHASE_1_OWNER_DECISION_ARTIFACT}`,
        `rg -n "^OWNER_DECISION: (COMPLETE|INCOMPLETE_RETRY)$" ${PHASE_1_OWNER_DECISION_ARTIFACT} >/dev/null`,
        `rg -n "^REASON: " ${PHASE_1_OWNER_DECISION_ARTIFACT} >/dev/null`,
        `if rg -n "^OWNER_DECISION: INCOMPLETE_RETRY$" ${PHASE_1_OWNER_DECISION_ARTIFACT} >/dev/null; then echo "phase_1_retry_requested"; exit 1; fi`,
        'echo phase_1_outcome_gate_ok',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      timeoutMs: 120_000,
    })

    .step('verify-implementation-phase-1-progress', {
      type: 'deterministic',
      dependsOn: ['gate-implement-supervisor-and-api-outcome'],
      command: [
        'set -e',
        'NON_TRANSIENT_IMPLEMENTATION=$({ git diff --name-only; git ls-files --others --exclude-standard; } | sort -u | rg -v "^(patches/|artifacts/|docs/.*plan\\.md$|.*output-manifest\\.txt$)" || true)',
        'if [ -z "$NON_TRANSIENT_IMPLEMENTATION" ]; then echo "empty_implementation_diff"; exit 1; fi',
        `printf "%s\\n" "$NON_TRANSIENT_IMPLEMENTATION" > ${IMPLEMENTATION_PHASE_1_FILES}`,
        `rg -n "^(packages/web/app/api/v1/ricky/runs/|packages/web/lib/ricky/|packages/web/drizzle/)" ${IMPLEMENTATION_PHASE_1_FILES} >/dev/null`,
        `if rg -n "^packages/web/drizzle/.*\\.sql$" ${IMPLEMENTATION_PHASE_1_FILES} >/dev/null; then rg -n "^packages/web/drizzle/meta/_journal\\.json$" ${IMPLEMENTATION_PHASE_1_FILES} >/dev/null; fi`,
        'echo implementation_phase_1_scope_ok',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      timeoutMs: 120_000,
    })

    .step('set-resume-marker-implement-repair-and-rerun-wiring', {
      type: 'deterministic',
      dependsOn: ['verify-implementation-phase-1-progress'],
      command: [
        'set -e',
        `echo "START_FROM=implement-repair-and-rerun-wiring" > ${RESUME_MARKER_ARTIFACT}`,
        `echo "PREVIOUS_RUN_ID=<previous-run-id>" >> ${RESUME_MARKER_ARTIFACT}`,
        'echo resume_marker_written_for_implement_repair_and_rerun_wiring',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      timeoutMs: 60_000,
    })

    .step('implement-repair-and-rerun-wiring', {
      agent: 'impl',
      dependsOn: ['set-resume-marker-implement-repair-and-rerun-wiring'],
      task: `Implement Ricky Cloud Auto-Fix v1 phase 2.

Phase 2 scope (must complete in this step):
- Complete evidence builder behavior under packages/web/lib/ricky/* using workflowRuns/workflowSteps/sessionEvents/logs/patch.
- Implement repair router behavior:
  - prefer workforce persona path when usable
  - fall back to OpenRouter path when subscription-backed paths are unavailable
- Implement rerun launcher semantics passing previousRunId/startFrom when available.
- Implement human gate prompt contract for unsafe/ambiguous/credential/secret/cost cases.
- Ensure final behavior can truthfully end in succeeded/exhausted/failed/human_denied/canceled/awaiting_human_gate.
- Preserve isolation: apply repairs only to isolated run copies.

Constraints:
- Keep changes scoped to Ricky cloud auto-fix implementation.
- Keep outputs and prompts model-agnostic.
- Never expose raw provider credential JSON in prompts/logs/events.
- Keep stdout concise: do not print file contents, huge logs, or full diffs.

Required machine-readable checkpoint:
- Write ${PHASE_2_OWNER_DECISION_ARTIFACT} before exit with exactly:
  OWNER_DECISION: COMPLETE
  REASON: <short reason>
  or
  OWNER_DECISION: INCOMPLETE_RETRY
  REASON: <precise blocker details>

When complete, exit successfully.`.trim(),
      verification: { type: 'exit_code' },
      timeoutMs: IMPLEMENTATION_PHASE_2_TIMEOUT_MS,
      retries: 0,
    })

    .step('gate-implement-repair-and-rerun-wiring-outcome', {
      type: 'deterministic',
      dependsOn: ['implement-repair-and-rerun-wiring'],
      command: [
        'set -e',
        `test -s ${PHASE_2_OWNER_DECISION_ARTIFACT}`,
        `rg -n "^OWNER_DECISION: (COMPLETE|INCOMPLETE_RETRY)$" ${PHASE_2_OWNER_DECISION_ARTIFACT} >/dev/null`,
        `rg -n "^REASON: " ${PHASE_2_OWNER_DECISION_ARTIFACT} >/dev/null`,
        `if rg -n "^OWNER_DECISION: INCOMPLETE_RETRY$" ${PHASE_2_OWNER_DECISION_ARTIFACT} >/dev/null; then echo "phase_2_retry_requested"; exit 1; fi`,
        'echo phase_2_outcome_gate_ok',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      timeoutMs: 120_000,
    })

    .step('verify-implementation-scope', {
      type: 'deterministic',
      dependsOn: ['gate-implement-repair-and-rerun-wiring-outcome'],
      command: [
        'set -e',
        'NON_TRANSIENT_IMPLEMENTATION=$({ git diff --name-only; git ls-files --others --exclude-standard; } | sort -u | rg -v "^(patches/|artifacts/|docs/.*plan\\.md$|.*output-manifest\\.txt$)" || true)',
        'if [ -z "$NON_TRANSIENT_IMPLEMENTATION" ]; then echo "empty_implementation_diff"; exit 1; fi',
        `printf "%s\\n" "$NON_TRANSIENT_IMPLEMENTATION" > ${IMPLEMENTATION_FILES}`,
        `rg -n "^(packages/web/app/api/v1/ricky/runs/|packages/web/lib/ricky/|packages/web/drizzle/)" ${IMPLEMENTATION_FILES} >/dev/null`,
        `if rg -n "^packages/web/drizzle/.*\\.sql$" ${IMPLEMENTATION_FILES} >/dev/null; then rg -n "^packages/web/drizzle/meta/_journal\\.json$" ${IMPLEMENTATION_FILES} >/dev/null; fi`,
        'echo implementation_scope_ok',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      timeoutMs: 120_000,
    })

    .step('set-resume-marker-implement-tests', {
      type: 'deterministic',
      dependsOn: ['verify-implementation-scope'],
      command: [
        'set -e',
        `echo "START_FROM=implement-tests" > ${RESUME_MARKER_ARTIFACT}`,
        `echo "PREVIOUS_RUN_ID=<previous-run-id>" >> ${RESUME_MARKER_ARTIFACT}`,
        'echo resume_marker_written_for_implement_tests',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      timeoutMs: 60_000,
    })

    .step('gate-implement-tests-inputs', {
      type: 'deterministic',
      dependsOn: ['set-resume-marker-implement-tests'],
      command: [
        'set -e',
        'mkdir -p artifacts/ricky .workflow-artifacts/ricky-auto-fix',
        `rm -f ${IMPLEMENT_TESTS_DECISION_ARTIFACT} ${IMPLEMENT_TESTS_CONTINUATION_ARTIFACT}`,
        `echo "IMPLEMENT_TESTS_SCOPE_CONTRACT" > ${IMPLEMENT_TESTS_SCOPE_ARTIFACT}`,
        'echo "Primary target step id is implement-tests." >> artifacts/ricky/implement-tests-scope.txt',
        'echo "Keep scope bounded to Ricky cloud auto-fix tests and route coverage." >> artifacts/ricky/implement-tests-scope.txt',
        'echo "If the first slice is incomplete, write continuation handoff artifact." >> artifacts/ricky/implement-tests-scope.txt',
        'echo implement_tests_input_gate_ok',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      timeoutMs: 60_000,
    })

    .step('implement-tests', {
      agent: 'tests',
      dependsOn: ['gate-implement-tests-inputs'],
      task: `Add or update tests for Ricky Cloud Auto-Fix v1.

Implementation files changed so far:
{{steps.verify-implementation-scope.output}}

Minimum test coverage:
- Agent availability resolver: usable/expired/missing/unhealthy + OpenRouter fallback readiness.
- Evidence builder: produces Ricky-compatible evidence from cloud rows and persists snapshot references.
- Repair router: prefers workforce persona when usable; falls back to OpenRouter when subscription-backed paths unavailable.
- Human gate creation for unsafe/ambiguous/credential/secret/cost cases.
- Rerun semantics pass previousRunId and startFrom when available.
- Max-attempt exhaustion path and truthful terminal statuses.

Also add/adjust integration tests for:
- failed root run -> repaired rerun success
- workforce repair path
- openrouter fallback path

Constraints:
- Keep changes under existing test structure (including tests/ricky where appropriate).
- Keep assertions deterministic.
- Keep stdout concise and avoid KEY:VALUE heading blocks in stdout.
- Prefer minimal, focused edits over broad rewrites.

Required machine-readable checkpoint:
- Write ${IMPLEMENT_TESTS_DECISION_ARTIFACT} before exit with exactly:
  OWNER_DECISION: COMPLETE
  REASON: <short reason>
  or
  OWNER_DECISION: INCOMPLETE_RETRY
  REASON: <precise blocker details>

RICKY_TIMEOUT_REPAIR:
- This step timed out in a previous run.
- Complete a bounded first slice only.
- If any work remains, write a concise handoff to ${IMPLEMENT_TESTS_CONTINUATION_ARTIFACT} and set OWNER_DECISION: INCOMPLETE_RETRY.

When complete, exit successfully.`.trim(),
      verification: { type: 'exit_code' },
      timeoutMs: TEST_STEP_TIMEOUT_MS,
      retries: 0,
    })

    .step('gate-implement-tests-outcome', {
      type: 'deterministic',
      dependsOn: ['implement-tests'],
      command: [
        'set -e',
        `test -s ${IMPLEMENT_TESTS_DECISION_ARTIFACT}`,
        `rg -n "^OWNER_DECISION: (COMPLETE|INCOMPLETE_RETRY)$" ${IMPLEMENT_TESTS_DECISION_ARTIFACT} >/dev/null`,
        `rg -n "^REASON: " ${IMPLEMENT_TESTS_DECISION_ARTIFACT} >/dev/null`,
        `if rg -n "^OWNER_DECISION: INCOMPLETE_RETRY$" ${IMPLEMENT_TESTS_DECISION_ARTIFACT} >/dev/null; then test -s ${IMPLEMENT_TESTS_CONTINUATION_ARTIFACT}; fi`,
        'echo implement_tests_outcome_gate_ok',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      timeoutMs: 120_000,
    })

    .step('set-resume-marker-implement-tests-timeout-continuation', {
      type: 'deterministic',
      dependsOn: ['gate-implement-tests-outcome'],
      command: [
        'set -e',
        `echo "START_FROM=implement-tests-timeout-continuation" > ${RESUME_MARKER_ARTIFACT}`,
        `echo "PREVIOUS_RUN_ID=<previous-run-id>" >> ${RESUME_MARKER_ARTIFACT}`,
        'echo resume_marker_written_for_implement_tests_timeout_continuation',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      timeoutMs: 60_000,
    })

    .step('implement-tests-timeout-continuation', {
      agent: 'tests',
      dependsOn: ['set-resume-marker-implement-tests-timeout-continuation'],
      timeoutMs: TESTS_CONTINUATION_TIMEOUT_MS,
      task: `Continue the previously time-bounded step "implement-tests".

Read ${IMPLEMENT_TESTS_DECISION_ARTIFACT} and any handoff in ${IMPLEMENT_TESTS_CONTINUATION_ARTIFACT}. Finish only remaining Ricky cloud auto-fix test work.

Fast path guard (execute first):
- If ${IMPLEMENT_TESTS_DECISION_ARTIFACT} already contains OWNER_DECISION: COMPLETE, do not run additional broad analysis or test rewrites.
- In that case, write ${IMPLEMENT_TESTS_CONTINUATION_ARTIFACT} with a short note and end the file with IMPLEMENT_TESTS_TIMEOUT_CONTINUATION_DONE, then exit successfully.

Continuation path:
- If ${IMPLEMENT_TESTS_DECISION_ARTIFACT} contains OWNER_DECISION: INCOMPLETE_RETRY, complete only the remaining test work from the handoff and then overwrite ${IMPLEMENT_TESTS_DECISION_ARTIFACT} to OWNER_DECISION: COMPLETE.
- If the handoff file is missing on INCOMPLETE_RETRY, create it from current evidence and continue; do not block waiting for non-existent inputs.

Requirements:
- Keep changes bounded to Ricky cloud auto-fix and related workflow-route tests.
- Keep prompts/outputs model-agnostic.
- Keep stdout concise.
- Overwrite ${IMPLEMENT_TESTS_DECISION_ARTIFACT} with OWNER_DECISION: COMPLETE when all required test coverage is done.
- End ${IMPLEMENT_TESTS_CONTINUATION_ARTIFACT} with IMPLEMENT_TESTS_TIMEOUT_CONTINUATION_DONE.

When complete, exit successfully.`,
      verification: { type: 'file_exists', value: IMPLEMENT_TESTS_CONTINUATION_ARTIFACT },
      retries: 0,
    })

    .step('gate-implement-tests-final', {
      type: 'deterministic',
      dependsOn: ['implement-tests-timeout-continuation'],
      command: [
        'set -e',
        `test -s ${IMPLEMENT_TESTS_DECISION_ARTIFACT}`,
        `rg -n "^OWNER_DECISION: COMPLETE$" ${IMPLEMENT_TESTS_DECISION_ARTIFACT} >/dev/null`,
        `test -s ${IMPLEMENT_TESTS_CONTINUATION_ARTIFACT}`,
        `tail -n 1 ${IMPLEMENT_TESTS_CONTINUATION_ARTIFACT} | rg -n "^IMPLEMENT_TESTS_TIMEOUT_CONTINUATION_DONE$" >/dev/null`,
        'echo implement_tests_final_gate_ok',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      timeoutMs: 120_000,
    })

    .step('verify-non-empty-implementation-diff', {
      type: 'deterministic',
      dependsOn: ['gate-implement-tests-final'],
      command: [
        'set -e',
        'DIFF_CANDIDATES=$({ git diff --name-only; git ls-files --others --exclude-standard; } | sort -u | rg -v "^(patches/|artifacts/|docs/.*plan\\.md$|.*output-manifest\\.txt$)" || true)',
        `if [ -n "$DIFF_CANDIDATES" ]; then printf "%s\\n" "$DIFF_CANDIDATES" > ${OUTPUT_MANIFEST}; elif [ -s ${IMPLEMENTATION_FILES} ]; then cp ${IMPLEMENTATION_FILES} ${OUTPUT_MANIFEST}; elif [ -s ${IMPLEMENTATION_PHASE_1_FILES} ]; then cp ${IMPLEMENTATION_PHASE_1_FILES} ${OUTPUT_MANIFEST}; else echo "empty_implementation_diff"; echo "resume_hint: use --start-from implement-tests --previous-run-id <previous-run-id>"; exit 1; fi`,
        `awk 'NF' ${OUTPUT_MANIFEST} | sort -u > ${OUTPUT_MANIFEST}.tmp`,
        `mv ${OUTPUT_MANIFEST}.tmp ${OUTPUT_MANIFEST}`,
        `test -s ${OUTPUT_MANIFEST}`,
        `rg -n "^(packages/web/app/api/v1/ricky/runs/|packages/web/lib/ricky/|packages/web/drizzle/)" ${OUTPUT_MANIFEST} >/dev/null`,
        `if ! rg -n "(^tests/ricky/|ricky.*test|tests/workflow-ref\\.test\\.ts|tests/workflow-run-route\\.test\\.ts)" ${OUTPUT_MANIFEST} >/dev/null; then echo "missing_expected_test_diff"; exit 1; fi`,
        `if rg -n "^packages/web/drizzle/.*\\.sql$" ${OUTPUT_MANIFEST} >/dev/null; then rg -n "^packages/web/drizzle/meta/_journal\\.json$" ${OUTPUT_MANIFEST} >/dev/null; fi`,
        'echo diff_ok',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      timeoutMs: 120_000,
    })

    .step('validate-output-manifest', {
      type: 'deterministic',
      dependsOn: ['verify-non-empty-implementation-diff'],
      command: [
        'set -e',
        `test -s ${OUTPUT_MANIFEST}`,
        `while IFS= read -r f; do test -f "$f" || (echo "missing_file:$f" && exit 1); done < ${OUTPUT_MANIFEST}`,
        'echo manifest_ok',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      timeoutMs: 120_000,
    })

    .step('validation-pass-1', {
      type: 'deterministic',
      dependsOn: ['validate-output-manifest'],
      command: [
        'set -e',
        'npm run web:drizzle-journal:test',
        'npm run orchestrator:test',
        'npx tsx --test tests/ricky/*.test.ts',
        'git diff --stat > artifacts/ricky/validation-pass-1-diff-stat.txt',
        'echo validation_pass_1_ok',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
      timeoutMs: 300_000,
    })

    .step('set-resume-marker-review-and-fix-loop', {
      type: 'deterministic',
      dependsOn: ['validation-pass-1'],
      command: [
        'set -e',
        `echo "START_FROM=review-and-fix-loop" > ${RESUME_MARKER_ARTIFACT}`,
        `echo "PREVIOUS_RUN_ID=<previous-run-id>" >> ${RESUME_MARKER_ARTIFACT}`,
        'echo resume_marker_written_for_review_and_fix_loop',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      timeoutMs: 60_000,
    })

    .step('gate-review-and-fix-loop-inputs', {
      type: 'deterministic',
      dependsOn: ['set-resume-marker-review-and-fix-loop'],
      command: [
        'set -e',
        'mkdir -p artifacts/ricky .workflow-artifacts/ricky-auto-fix',
        `rm -f ${REVIEW_LOOP_DECISION_ARTIFACT} ${REVIEW_LOOP_CONTINUATION_ARTIFACT}`,
        `echo "REVIEW_LOOP_SCOPE_CONTRACT" > ${REVIEW_LOOP_SCOPE_ARTIFACT}`,
        'echo "Start from review-and-fix-loop and keep changes scoped to Ricky cloud auto-fix." >> artifacts/ricky/review-and-fix-loop-scope.txt',
        'echo "Preserve model-agnostic prompts and outputs." >> artifacts/ricky/review-and-fix-loop-scope.txt',
        'echo "If work remains after the bounded slice, write a continuation handoff artifact." >> artifacts/ricky/review-and-fix-loop-scope.txt',
        'echo review_fix_loop_input_gate_ok',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      timeoutMs: 60_000,
    })

    .step('review-and-fix-loop', {
      agent: 'impl',
      dependsOn: ['gate-review-and-fix-loop-inputs'],
      task: `Review repository diff and validation output, then fix any failing behavior.

Validation output:
{{steps.validation-pass-1.output}}

Required 80-to-100 loop behavior:
1) If any command failed, identify root cause from concrete evidence.
2) Apply minimal, correct fixes in source + tests.
3) Preserve security constraints (no raw credential JSON exposure).
4) Preserve rerun semantics (previousRunId/startFrom) and evidence snapshot semantics.
5) Keep changes scoped to Ricky cloud auto-fix implementation.
6) Keep output model-agnostic and compatible with existing router/workload wiring.
7) Keep stdout concise: no file dumps or long transcripts.

Required machine-readable checkpoint:
- Write ${REVIEW_LOOP_DECISION_ARTIFACT} before exit with exactly:
  OWNER_DECISION: COMPLETE
  REASON: <short reason>
  or
  OWNER_DECISION: INCOMPLETE_RETRY
  REASON: <precise blocker details>

RICKY_TIMEOUT_REPAIR:
- This step previously exhausted its agent timeout/retries.
- Complete a bounded first slice only, then write a concise handoff for the continuation step to ${REVIEW_LOOP_CONTINUATION_ARTIFACT}.
- Preserve any work already completed in the repository.
- If the original task has multiple coverage areas, do not try to finish all of them in this one agent turn.`.trim(),
      verification: { type: 'exit_code' },
      retries: 0,
      timeoutMs: REVIEW_STEP_TIMEOUT_MS,
    })

    .step('gate-review-and-fix-loop-outcome', {
      type: 'deterministic',
      dependsOn: ['review-and-fix-loop'],
      command: [
        'set -e',
        `test -s ${REVIEW_LOOP_DECISION_ARTIFACT}`,
        `rg -n "^OWNER_DECISION: (COMPLETE|INCOMPLETE_RETRY)$" ${REVIEW_LOOP_DECISION_ARTIFACT} >/dev/null`,
        `rg -n "^REASON: " ${REVIEW_LOOP_DECISION_ARTIFACT} >/dev/null`,
        `if rg -n "^OWNER_DECISION: INCOMPLETE_RETRY$" ${REVIEW_LOOP_DECISION_ARTIFACT} >/dev/null; then test -s ${REVIEW_LOOP_CONTINUATION_ARTIFACT}; fi`,
        'echo review_fix_loop_outcome_gate_ok',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      timeoutMs: 120_000,
    })

    .step('review-and-fix-loop-timeout-continuation', {
      agent: 'impl',
      dependsOn: ['gate-review-and-fix-loop-outcome'],
      timeoutMs: REVIEW_LOOP_CONTINUATION_TIMEOUT_MS,
      task: `Continue the previously timed-out workflow step "review-and-fix-loop".

Read any handoff or summary produced by review-and-fix-loop, inspect the current git diff, and finish only the remaining work from that original step. Keep the scope bounded and preserve existing edits.

Fast path guard (execute first):
- If ${REVIEW_LOOP_DECISION_ARTIFACT} already contains OWNER_DECISION: COMPLETE, do not perform additional broad edits.
- In that case, write ${REVIEW_LOOP_CONTINUATION_ARTIFACT} ending with REVIEW_AND_FIX_LOOP_TIMEOUT_CONTINUATION_DONE, then exit successfully.

Continuation path:
- If ${REVIEW_LOOP_DECISION_ARTIFACT} contains OWNER_DECISION: INCOMPLETE_RETRY, complete only the remaining bounded work from the handoff and preserve prior edits.

Write ${REVIEW_LOOP_CONTINUATION_ARTIFACT} ending with REVIEW_AND_FIX_LOOP_TIMEOUT_CONTINUATION_DONE.`,
      verification: { type: 'file_exists', value: REVIEW_LOOP_CONTINUATION_ARTIFACT },
    })

    .step('hard-validation', {
      type: 'deterministic',
      dependsOn: ['review-and-fix-loop-timeout-continuation'],
      command: [
        'set -e',
        'npm run web:drizzle-journal:test',
        'npm run orchestrator:test',
        'npx tsx --test tests/ricky/*.test.ts',
        `{ git diff --name-only; git ls-files --others --exclude-standard; } | sort -u > ${FINAL_DIFF_FILES}`,
        `test -s ${FINAL_DIFF_FILES}`,
        'git diff --stat > artifacts/ricky/final-diff-stat.txt',
        `echo "HARD_VALIDATION_OK" > ${HARD_VALIDATION_ARTIFACT}`,
        `echo "TEST_SCOPE=ricky_cloud_autofix_v1" >> ${HARD_VALIDATION_ARTIFACT}`,
        'echo hard_validation_ok',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      timeoutMs: 300_000,
    })

    .step('set-resume-marker-final-signoff', {
      type: 'deterministic',
      dependsOn: ['hard-validation'],
      command: [
        'set -e',
        `echo "START_FROM=final-signoff" > ${RESUME_MARKER_ARTIFACT}`,
        `echo "PREVIOUS_RUN_ID=<previous-run-id>" >> ${RESUME_MARKER_ARTIFACT}`,
        'echo resume_marker_written_for_final_signoff',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      timeoutMs: 60_000,
    })

    .step('final-signoff', {
      type: 'deterministic',
      dependsOn: ['set-resume-marker-final-signoff'],
      command: [
        'set -e',
        `test -s ${HARD_VALIDATION_ARTIFACT}`,
        `rg -n "^HARD_VALIDATION_OK$" ${HARD_VALIDATION_ARTIFACT} >/dev/null`,
        `test -s ${FINAL_DIFF_FILES}`,
        `test -s ${OUTPUT_MANIFEST}`,
        `test -s ${PLAN_ARTIFACT}`,
        `test -s ${ROUTER_STATE_ARTIFACT}`,
        `test -s ${ROUTER_STATE_SUMMARY}`,
        `test -s ${IMPLEMENT_TESTS_DECISION_ARTIFACT}`,
        `test -s ${IMPLEMENT_TESTS_CONTINUATION_ARTIFACT}`,
        `test -s ${REVIEW_LOOP_DECISION_ARTIFACT}`,
        `test -s ${REVIEW_LOOP_CONTINUATION_ARTIFACT}`,
        `rg -n "^OWNER_DECISION: COMPLETE$" ${IMPLEMENT_TESTS_DECISION_ARTIFACT} >/dev/null`,
        `tail -n 1 ${IMPLEMENT_TESTS_CONTINUATION_ARTIFACT} | rg -n "^IMPLEMENT_TESTS_TIMEOUT_CONTINUATION_DONE$" >/dev/null`,
        `rg -n "^OWNER_DECISION: COMPLETE$" ${REVIEW_LOOP_DECISION_ARTIFACT} >/dev/null`,
        `tail -n 1 ${REVIEW_LOOP_CONTINUATION_ARTIFACT} | rg -n "^REVIEW_AND_FIX_LOOP_TIMEOUT_CONTINUATION_DONE$" >/dev/null`,
        `rg -n "Steps \\(minimal, testable\\)" ${PLAN_ARTIFACT} >/dev/null`,
        `rg -n "Explicit wiring steps \\(API, DB, supervisor, adapters\\)" ${PLAN_ARTIFACT} >/dev/null`,
        `rg -n "Concrete task-to-workflow mapping example" ${PLAN_ARTIFACT} >/dev/null`,
        `rg -n "Integration testing notes" ${PLAN_ARTIFACT} >/dev/null`,
        `rg -n "ROUTER_STATE_FILE=" ${ROUTER_STATE_SUMMARY} >/dev/null`,
        `rg -n "^(packages/web/app/api/v1/ricky/runs/|packages/web/lib/ricky/|packages/web/drizzle/|tests/ricky/|tests/workflow-ref\\.test\\.ts|tests/workflow-run-route\\.test\\.ts)" ${FINAL_DIFF_FILES} >/dev/null`,
        `printf "%s\\n" "FINAL_SIGNOFF: APPROVED" "REASON: deterministic acceptance gates passed with hard-validation evidence" > ${FINAL_SIGNOFF_ARTIFACT}`,
        'echo final_signoff_approved',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      timeoutMs: SIGNOFF_TIMEOUT_MS,
    })

    .step('gate-final-signoff-outcome', {
      type: 'deterministic',
      dependsOn: ['final-signoff'],
      command: [
        'set -e',
        `test -s ${FINAL_SIGNOFF_ARTIFACT}`,
        `rg -n "^FINAL_SIGNOFF: APPROVED$" ${FINAL_SIGNOFF_ARTIFACT} >/dev/null`,
        `rg -n "^REASON: " ${FINAL_SIGNOFF_ARTIFACT} >/dev/null`,
        'echo final_signoff_gate_ok',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      timeoutMs: 60_000,
    })

    .onError('fail-fast')
    .run({ cwd: process.cwd() });

  console.log(`Workflow status: ${result.status} (${result.id})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
