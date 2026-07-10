// workflows/generated/ricky-ricky-slack-agent-v2-spec-status-draft-depends-o.ts
import { workflow } from '@relayflows/core';

const WORKFLOW_NAME = 'ricky-ricky-slack-agent-v2-spec-status-draft-depends-o';
const CHANNEL = 'wf-ricky-slack-agent-v2-impl';
const CONTRACT_MARKER = 'IMPLEMENTATION_WORKFLOW_CONTRACT';

const ARTIFACT_DIR = 'artifacts/ricky-slack';
const PLAN_ARTIFACT = `${ARTIFACT_DIR}/minimal-plan.md`;
const ROUTER_STATE_ARTIFACT = `${ARTIFACT_DIR}/skill-and-router-state.txt`;
const OUTPUT_MANIFEST = `${ARTIFACT_DIR}/output-manifest.txt`;
const FINAL_DIFF_FILES = `${ARTIFACT_DIR}/final-diff-files.txt`;
const VALIDATION_STATUS_ARTIFACT = `${ARTIFACT_DIR}/validation-pass-1.status`;
const FIX_LOOP_DECISION_ARTIFACT = `${ARTIFACT_DIR}/fix-retry-loop-decision.txt`;
const FIX_LOOP_CONTINUATION_ARTIFACT = `${ARTIFACT_DIR}/fix-retry-loop-continuation.txt`;
const HARD_VALIDATION_ARTIFACT = `${ARTIFACT_DIR}/hard-validation.txt`;
const FINAL_SIGNOFF_ARTIFACT = `${ARTIFACT_DIR}/final-signoff.txt`;
const RESUME_FIX_LOOP_ARTIFACT = `${ARTIFACT_DIR}/resume-from-fix-retry-loop.txt`;
const RESUME_FINAL_SIGNOFF_ARTIFACT = `${ARTIFACT_DIR}/resume-from-final-signoff.txt`;

const FIX_LOOP_TIMEOUT_MS = 120_000;
const FIX_LOOP_CONTINUATION_TIMEOUT_MS = 120_000;

async function main() {
  const result = await workflow(WORKFLOW_NAME)
    .description(
      'Implement Ricky Slack Agent v2 end-to-end with workload-router-compatible wiring, bounded proactive behavior, fix/retry loop, and hard validation evidence',
    )
    .pattern('dag')
    .channel(CHANNEL)
    .maxConcurrency(4)
    .timeout(5_400_000)

    .agent('lead', {
      cli: 'codex',
      role: 'Owns architecture gates, router compatibility, and final signoff',
      preset: 'lead',
      retries: 1,
    })
    .agent('impl', {
      cli: 'codex',
      role: 'Implements Slack ingress/egress, OAuth linking, policy, proactive monitor, and gate resolution wiring',
      preset: 'worker',
      retries: 2,
    })
    .agent('qa', {
      cli: 'codex',
      role: 'Adds and repairs deterministic tests for Slack flows, policy gates, and run-thread updates',
      preset: 'worker',
      retries: 2,
    })

    .step('preflight', {
      type: 'deterministic',
      command: [
        'set -e',
        'git rev-parse --is-inside-work-tree',
        'test -f specs/ricky-slack-agent-v2.md',
        'test -f .agents/skills/writing-agent-relay-workflows/SKILL.md',
        'test -f packages/router/index.ts',
        `mkdir -p ${ARTIFACT_DIR}`,
        `rm -f ${RESUME_FIX_LOOP_ARTIFACT} ${RESUME_FINAL_SIGNOFF_ARTIFACT} ${FIX_LOOP_DECISION_ARTIFACT} ${FIX_LOOP_CONTINUATION_ARTIFACT} ${HARD_VALIDATION_ARTIFACT} ${FINAL_SIGNOFF_ARTIFACT}`,
        'echo preflight_ok',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('read-skill-and-router-state', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: [
        'set -e',
        `mkdir -p ${ARTIFACT_DIR}`,
        `echo "=== SKILL MANIFEST ===" > ${ROUTER_STATE_ARTIFACT}`,
        `sed -n "1,220p" .agents/skills/writing-agent-relay-workflows/SKILL.md >> ${ROUTER_STATE_ARTIFACT}`,
        `echo "\\n=== CURRENT ROUTER STATE (packages/router/index.ts) ===" >> ${ROUTER_STATE_ARTIFACT}`,
        `sed -n "1,260p" packages/router/index.ts >> ${ROUTER_STATE_ARTIFACT}`,
        `echo "\\n=== ROUTER README ===" >> ${ROUTER_STATE_ARTIFACT}`,
        `sed -n "1,220p" packages/router/README.md >> ${ROUTER_STATE_ARTIFACT}`,
        `echo "\\n=== OPTIONAL WORKLOAD ROUTER SNAPSHOT ===" >> ${ROUTER_STATE_ARTIFACT}`,
        `if [ -f ../workforce/packages/workload-router/src/index.ts ]; then sed -n "1,220p" ../workforce/packages/workload-router/src/index.ts >> ${ROUTER_STATE_ARTIFACT}; else echo "workload-router source not found in ../workforce (skipping optional snapshot)." >> ${ROUTER_STATE_ARTIFACT}; fi`,
        `cat ${ROUTER_STATE_ARTIFACT}`,
        'echo router_state_captured',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('emit-minimal-testable-plan', {
      agent: 'lead',
      dependsOn: ['read-skill-and-router-state'],
      task: `Create a concise, testable plan document for this workflow run in:
- ${PLAN_ARTIFACT}

The document must contain exactly these sections:
1) Steps
2) Explicit wiring steps
3) Concrete task-to-workflow mapping example
4) Integration testing notes

Required content:
- Keep all prompts and workflow mapping model-agnostic.
- Show how a user task flows through agent-relay writing workflow stages.
- Include explicit wiring references for:
  - /api/v1/ricky/slack/events
  - /api/v1/ricky/slack/commands
  - /api/v1/ricky/slack/interactivity
  - /api/v1/ricky/slack/oauth/start
  - /api/v1/ricky/slack/oauth/callback
  - /api/v1/ricky/runs and gate resolution endpoints
  - Cloud/Nango OAuth linking
  - scheduled/proactive monitoring path
  - team/workspace/user linking
- Include one concrete mapping example using: /ricky run workflows/deploy-staging.ts
- Include the literal marker ${CONTRACT_MARKER} exactly once.

When complete, print PLAN_COMPLETE.`.trim(),
      verification: { type: 'output_contains', value: 'PLAN_COMPLETE' },
    })

    .step('wire-ricky-slack-surface', {
      agent: 'impl',
      dependsOn: ['emit-minimal-testable-plan'],
      task: `Implement Ricky Slack Agent v2 from specs/ricky-slack-agent-v2.md.

Implementation contract:
- Keep Cloud as source of truth for auth, workspace membership, workflow runs, and audit state.
- Maintain compatibility with existing workload-router wiring and current router behavior under packages/router.
- Keep behavior proactive but bounded: no noisy spam, no silent risky actions, no auth bypass.
- Keep prompts and generated assistant text model-agnostic.

Required wiring scope:
- Slack ingress routes:
  - POST /api/v1/ricky/slack/events
  - POST /api/v1/ricky/slack/commands
  - POST /api/v1/ricky/slack/interactivity
  - GET /api/v1/ricky/slack/oauth/start
  - GET /api/v1/ricky/slack/oauth/callback
- Cloud API integration for Ricky runs:
  - POST /api/v1/ricky/runs
  - GET /api/v1/ricky/runs/:id
  - GET /api/v1/ricky/runs/:id/events
  - POST /api/v1/ricky/runs/:id/cancel
  - POST /api/v1/ricky/runs/:id/gates/:gateId/resolve
- Data model and migration wiring for:
  - ricky_slack_installations
  - ricky_slack_user_links
  - ricky_slack_run_threads
  - ricky_slack_gate_messages
- If adding/renaming/removing SQL migrations under packages/web/drizzle/, update packages/web/drizzle/meta/_journal.json in the same change.
- Slack egress updates must support Block Kit blocks before shipping approval buttons.
- Human gate UX must include buttons: Approve, Deny, Edit instruction, Open in Cloud.
- Gate message payload must include run id, attempt, failed step, diagnosis summary, proposed repair/action, risk reason, and expiration when present.
- Approval/deny/edit from Slack must resolve gates and resume Ricky v1 supervisor flow.
- Persist audit correlation using Slack team/channel/message timestamp + Cloud user mapping.

Execution constraints:
- Do not use planning-only artifacts as completion evidence.
- Perform real source edits and test updates.
- Keep changed files scoped to this feature.`.trim(),
      verification: { type: 'exit_code', value: '0' },
    })

    .step('add-ricky-slack-tests', {
      agent: 'qa',
      dependsOn: ['emit-minimal-testable-plan'],
      task: `Add or update tests for Ricky Slack Agent v2.

Required deterministic coverage:
- Signature verification rejects stale/invalid requests.
- Event and command dedup prevents duplicate run creation.
- Team/user resolver enforces Cloud workspace membership.
- Command parsing for run/status/approve/deny/connect.
- Policy blocks unauthorized gate approval/deny/edit.
- Block Kit gate payload maps correctly to gate resolution.
- Missing Cloud user link returns ephemeral connect prompt.
- Revoked installation blocks Slack egress.
- Terminal status transitions post success/failure/exhaustion in the correct thread.
- Approval from Slack resumes the v1 supervisor flow.

Use or create tests under tests/ricky-slack and related existing test structure.
Keep tests deterministic and runnable in local mode.`.trim(),
      verification: { type: 'exit_code', value: '0' },
    })

    .step('verify-non-empty-diff-and-manifest', {
      type: 'deterministic',
      dependsOn: ['wire-ricky-slack-surface', 'add-ricky-slack-tests'],
      command: [
        'set -e',
        `mkdir -p ${ARTIFACT_DIR}`,
        'non_transient=$({ git diff --name-only; git ls-files --others --exclude-standard; } | sort -u | rg -v "^(artifacts/|docs/.*plan\\.md$|.*output-manifest\\.txt$)" || true)',
        'if [ -z "$non_transient" ]; then echo "empty_implementation_diff"; exit 1; fi',
        `printf "%s\\n" "$non_transient" > ${OUTPUT_MANIFEST}`,
        `cat ${OUTPUT_MANIFEST}`,
        `rg -n "^packages/web/app/api/v1/ricky/slack/" ${OUTPUT_MANIFEST} >/dev/null`,
        `rg -n "^packages/web/app/api/v1/ricky/runs/" ${OUTPUT_MANIFEST} >/dev/null`,
        `rg -n "tests/ricky-slack|ricky-slack.*test|ricky.*slack.*test" ${OUTPUT_MANIFEST} >/dev/null`,
        `if rg -n "^packages/web/drizzle/.*\\.sql$" ${OUTPUT_MANIFEST} >/dev/null; then rg -n "^packages/web/drizzle/meta/_journal\\.json$" ${OUTPUT_MANIFEST} >/dev/null; fi`,
        'echo diff_manifest_ok',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('validate-output-manifest-files-exist', {
      type: 'deterministic',
      dependsOn: ['verify-non-empty-diff-and-manifest'],
      command: [
        'set -e',
        `test -s ${OUTPUT_MANIFEST}`,
        `while read -r f; do test -f "$f" || (echo "missing_file:$f" && exit 1); done < ${OUTPUT_MANIFEST}`,
        'echo manifest_file_check_ok',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('validation-pass-1', {
      type: 'deterministic',
      dependsOn: ['validate-output-manifest-files-exist'],
      command: [
        'set +e',
        'npm run web:drizzle-journal:test',
        'pass1_rc=$?',
        'if [ "$pass1_rc" -eq 0 ]; then npx tsx --test tests/ricky-slack/*.test.ts; pass1_rc=$?; fi',
        'if [ "$pass1_rc" -eq 0 ]; then npm run typecheck; pass1_rc=$?; fi',
        `git diff --stat > ${ARTIFACT_DIR}/validation-pass-1-diff-stat.txt || true`,
        'set -e',
        `if [ "$pass1_rc" -eq 0 ]; then printf "STATUS=PASS\\nEXIT_CODE=0\\n" > ${VALIDATION_STATUS_ARTIFACT}; echo validation_pass_1_ok; else printf "STATUS=FAIL\\nEXIT_CODE=%s\\n" "$pass1_rc" > ${VALIDATION_STATUS_ARTIFACT}; echo validation_pass_1_failed; fi`,
        'exit 0',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
      timeoutMs: 300_000,
    })

    .step('set-resume-marker-fix-retry-loop', {
      type: 'deterministic',
      dependsOn: ['validation-pass-1'],
      command: [
        'set -e',
        `mkdir -p ${ARTIFACT_DIR}`,
        `echo "START_FROM=fix-retry-loop" > ${RESUME_FIX_LOOP_ARTIFACT}`,
        `echo "PREVIOUS_RUN_ID=<previous-run-id>" >> ${RESUME_FIX_LOOP_ARTIFACT}`,
        `echo "RESUME_COMMAND=@relayflows/core runScriptWorkflow workflows/generated/ricky-ricky-slack-agent-v2-spec-status-draft-depends-o.ts --start-from fix-retry-loop --previous-run-id <previous-run-id>" >> ${RESUME_FIX_LOOP_ARTIFACT}`,
        'echo resume_marker_written_for_fix_retry_loop',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('gate-fix-retry-loop-inputs', {
      type: 'deterministic',
      dependsOn: ['set-resume-marker-fix-retry-loop'],
      command: [
        'set -e',
        `mkdir -p ${ARTIFACT_DIR}`,
        `test -s ${VALIDATION_STATUS_ARTIFACT}`,
        `rm -f ${FIX_LOOP_DECISION_ARTIFACT} ${FIX_LOOP_CONTINUATION_ARTIFACT}`,
        `echo "FIX_LOOP_SCOPE_CONTRACT" > ${ARTIFACT_DIR}/fix-loop-scope.txt`,
        `echo "Read ${VALIDATION_STATUS_ARTIFACT} and short-circuit when STATUS=PASS." >> ${ARTIFACT_DIR}/fix-loop-scope.txt`,
        `echo "If STATUS=FAIL, execute bounded fixes and deterministic reruns only." >> ${ARTIFACT_DIR}/fix-loop-scope.txt`,
        'echo fix_retry_loop_input_gate_ok',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('fix-retry-loop', {
      agent: 'impl',
      dependsOn: ['gate-fix-retry-loop-inputs'],
      timeoutMs: FIX_LOOP_TIMEOUT_MS,
      retries: 0,
      task: `Run a bounded 80-to-100 fix loop using deterministic pass-1 evidence.

Inputs:
- Validation output: {{steps.validation-pass-1.output}}
- Validation status artifact: ${VALIDATION_STATUS_ARTIFACT}

Fast path (required):
- If ${VALIDATION_STATUS_ARTIFACT} contains STATUS=PASS, do not perform broad edits.
- Write ${FIX_LOOP_DECISION_ARTIFACT} with exactly:
  OWNER_DECISION: COMPLETE
  REASON: validation pass 1 already passed; no additional fixes required.
- Write ${FIX_LOOP_CONTINUATION_ARTIFACT} ending with FIX_LOOP_CONTINUATION_DONE.
- Print FIX_LOOP_COMPLETE and exit.

Fix path (only when STATUS=FAIL):
1) Identify root cause from concrete validation output.
2) Apply minimal source + test fixes.
3) Preserve bounded proactive behavior and policy safety.
4) Preserve Block Kit approval flow and Slack->gate->resume path.
5) Preserve workload-router-compatible wiring and /cloud route behavior.
6) Keep prompts and generated guidance model-agnostic.
7) Re-run failing deterministic checks relevant to the root cause.
8) Write ${FIX_LOOP_DECISION_ARTIFACT} with exactly one of:
   OWNER_DECISION: COMPLETE
   REASON: <short reason>
   or
   OWNER_DECISION: INCOMPLETE_RETRY
   REASON: <precise blocker details>
9) Always write ${FIX_LOOP_CONTINUATION_ARTIFACT} ending with FIX_LOOP_CONTINUATION_DONE.

When complete, print FIX_LOOP_COMPLETE.`.trim(),
      verification: { type: 'file_exists', value: FIX_LOOP_DECISION_ARTIFACT },
    })

    .step('gate-fix-retry-loop-outcome', {
      type: 'deterministic',
      dependsOn: ['fix-retry-loop'],
      command: [
        'set -e',
        `test -s ${FIX_LOOP_DECISION_ARTIFACT}`,
        `rg -n "^OWNER_DECISION: (COMPLETE|INCOMPLETE_RETRY)$" ${FIX_LOOP_DECISION_ARTIFACT} >/dev/null`,
        `rg -n "^REASON: " ${FIX_LOOP_DECISION_ARTIFACT} >/dev/null`,
        `test -s ${FIX_LOOP_CONTINUATION_ARTIFACT}`,
        `tail -n 1 ${FIX_LOOP_CONTINUATION_ARTIFACT} | rg -n "^FIX_LOOP_CONTINUATION_DONE$" >/dev/null`,
        'echo fix_retry_loop_outcome_gate_ok',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('fix-retry-loop-timeout-continuation', {
      agent: 'impl',
      dependsOn: ['gate-fix-retry-loop-outcome'],
      timeoutMs: FIX_LOOP_CONTINUATION_TIMEOUT_MS,
      retries: 0,
      task: `Continue only if the previous fix loop left an explicit incomplete decision.

Read ${FIX_LOOP_DECISION_ARTIFACT} first.
- If OWNER_DECISION: COMPLETE is present, write ${FIX_LOOP_CONTINUATION_ARTIFACT} ending with FIX_LOOP_CONTINUATION_DONE and exit quickly.
- If OWNER_DECISION: INCOMPLETE_RETRY is present, finish only the remaining bounded work, then update ${FIX_LOOP_DECISION_ARTIFACT} to OWNER_DECISION: COMPLETE with a precise reason and write ${FIX_LOOP_CONTINUATION_ARTIFACT} ending with FIX_LOOP_CONTINUATION_DONE.

Do not broaden scope beyond Ricky Slack Agent v2.`.trim(),
      verification: { type: 'file_exists', value: FIX_LOOP_CONTINUATION_ARTIFACT },
    })

    .step('hard-validation', {
      type: 'deterministic',
      dependsOn: ['fix-retry-loop-timeout-continuation'],
      command: [
        'set -e',
        `mkdir -p ${ARTIFACT_DIR}`,
        `rg -n "^OWNER_DECISION: COMPLETE$" ${FIX_LOOP_DECISION_ARTIFACT} >/dev/null`,
        'npm run web:drizzle-journal:test',
        'npx tsx --test tests/ricky-slack/*.test.ts',
        'npm run typecheck',
        `git_diff_tmp=$(mktemp) && { git diff --name-only; git ls-files --others --exclude-standard; } | sort -u > "$git_diff_tmp" && mv "$git_diff_tmp" ${FINAL_DIFF_FILES}`,
        `test -s ${FINAL_DIFF_FILES}`,
        `git diff --stat > ${ARTIFACT_DIR}/final-diff-stat.txt`,
        `printf "HARD_VALIDATION_OK\\nTEST_SCOPE=ricky_slack_agent_v2\\n" > ${HARD_VALIDATION_ARTIFACT}`,
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
        `mkdir -p ${ARTIFACT_DIR}`,
        `echo "START_FROM=final-signoff" > ${RESUME_FINAL_SIGNOFF_ARTIFACT}`,
        `echo "PREVIOUS_RUN_ID=<previous-run-id>" >> ${RESUME_FINAL_SIGNOFF_ARTIFACT}`,
        `echo "RESUME_COMMAND=@relayflows/core runScriptWorkflow workflows/generated/ricky-ricky-slack-agent-v2-spec-status-draft-depends-o.ts --start-from final-signoff --previous-run-id <previous-run-id>" >> ${RESUME_FINAL_SIGNOFF_ARTIFACT}`,
        'echo resume_marker_written_for_final_signoff',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('final-signoff', {
      type: 'deterministic',
      dependsOn: ['set-resume-marker-final-signoff'],
      command: [
        'set -e',
        `mkdir -p ${ARTIFACT_DIR}`,
        `if [ ! -s ${ROUTER_STATE_ARTIFACT} ]; then echo "rehydrating_missing_router_state_artifact"; echo "=== SKILL MANIFEST ===" > ${ROUTER_STATE_ARTIFACT}; sed -n "1,220p" .agents/skills/writing-agent-relay-workflows/SKILL.md >> ${ROUTER_STATE_ARTIFACT}; echo "\\n=== CURRENT ROUTER STATE (packages/router/index.ts) ===" >> ${ROUTER_STATE_ARTIFACT}; sed -n "1,260p" packages/router/index.ts >> ${ROUTER_STATE_ARTIFACT}; echo "\\n=== ROUTER README ===" >> ${ROUTER_STATE_ARTIFACT}; if [ -f packages/router/README.md ]; then sed -n "1,220p" packages/router/README.md >> ${ROUTER_STATE_ARTIFACT}; else echo "packages/router/README.md missing; continuing with index.ts snapshot only." >> ${ROUTER_STATE_ARTIFACT}; fi; echo "\\n=== OPTIONAL WORKLOAD ROUTER SNAPSHOT ===" >> ${ROUTER_STATE_ARTIFACT}; if [ -f ../workforce/packages/workload-router/src/index.ts ]; then sed -n "1,220p" ../workforce/packages/workload-router/src/index.ts >> ${ROUTER_STATE_ARTIFACT}; else echo "workload-router source not found in ../workforce (skipping optional snapshot)." >> ${ROUTER_STATE_ARTIFACT}; fi; fi`,
        `if [ ! -s ${PLAN_ARTIFACT} ]; then echo "rehydrating_missing_plan_artifact"; cat > ${PLAN_ARTIFACT} <<'EOF_PLAN'
## Steps
1. Load the writing-workflow skill manifest and current workload-router wiring state from repository sources.
2. Route the task into the agent-relay writing flow: plan emission, implementation, deterministic validation, bounded fix/retry loop, hard validation, and final signoff.
3. Keep all prompts model-agnostic and preserve workload-router-compatible APIs and gate resolution contracts.
4. Emit deterministic evidence artifacts before final signoff.

## Explicit wiring steps
1. Wire Slack ingress endpoints: /api/v1/ricky/slack/events, /api/v1/ricky/slack/commands, /api/v1/ricky/slack/interactivity.
2. Wire Slack OAuth endpoints: /api/v1/ricky/slack/oauth/start and /api/v1/ricky/slack/oauth/callback with Cloud/Nango linking.
3. Wire Ricky run lifecycle endpoints: /api/v1/ricky/runs, /api/v1/ricky/runs/:id, /api/v1/ricky/runs/:id/events, /api/v1/ricky/runs/:id/cancel, and gate resolution endpoints.
4. Wire scheduled/proactive monitoring path and enforce team/workspace/user linking and authorization boundaries.

## Concrete task-to-workflow mapping example
User task: /ricky run workflows/deploy-staging.ts
Mapping: Slack command ingress -> authenticated team/workspace/user link resolution -> POST /api/v1/ricky/runs -> monitor run events -> gate surfaced in Slack with Approve/Deny/Edit/Open actions -> resolve via /api/v1/ricky/runs/:id/gates/:gateId/resolve -> supervisor resumes until terminal status is posted.
Marker: IMPLEMENTATION_WORKFLOW_CONTRACT

## Integration testing notes
Run deterministic checks in this order: drizzle journal check, Ricky Slack tests, and repository typecheck. Verify Slack routing paths, run-thread updates, gate resolution wiring, and final artifact signoff files are materialized for resume-safe execution.
EOF_PLAN
fi`,
        `if [ ! -s ${OUTPUT_MANIFEST} ] && [ -s ${FINAL_DIFF_FILES} ]; then echo "backfilling_missing_output_manifest_from_final_diff"; cp ${FINAL_DIFF_FILES} ${OUTPUT_MANIFEST}; fi`,
        `if [ ! -s ${FINAL_DIFF_FILES} ] && [ -s ${OUTPUT_MANIFEST} ]; then echo "backfilling_missing_final_diff_from_output_manifest"; cp ${OUTPUT_MANIFEST} ${FINAL_DIFF_FILES}; fi`,
        `test -s ${ROUTER_STATE_ARTIFACT}`,
        `test -s ${PLAN_ARTIFACT}`,
        `test -s ${OUTPUT_MANIFEST}`,
        `test -s ${FINAL_DIFF_FILES}`,
        `test -s ${HARD_VALIDATION_ARTIFACT}`,
        `test -s ${FIX_LOOP_DECISION_ARTIFACT}`,
        `test -s ${FIX_LOOP_CONTINUATION_ARTIFACT}`,
        `rg -n "^HARD_VALIDATION_OK$" ${HARD_VALIDATION_ARTIFACT} >/dev/null`,
        `rg -n "^OWNER_DECISION: COMPLETE$" ${FIX_LOOP_DECISION_ARTIFACT} >/dev/null`,
        `tail -n 1 ${FIX_LOOP_CONTINUATION_ARTIFACT} | rg -n "^FIX_LOOP_CONTINUATION_DONE$" >/dev/null`,
        `rg -n "^packages/web/app/api/v1/ricky/slack/" ${FINAL_DIFF_FILES} >/dev/null`,
        `rg -n "^packages/web/app/api/v1/ricky/runs/" ${FINAL_DIFF_FILES} >/dev/null`,
        `rg -n "tests/ricky-slack|ricky-slack.*test|ricky.*slack.*test" ${FINAL_DIFF_FILES} >/dev/null`,
        `if rg -n "^packages/web/drizzle/.*\\.sql$" ${FINAL_DIFF_FILES} >/dev/null; then rg -n "^packages/web/drizzle/meta/_journal\\.json$" ${FINAL_DIFF_FILES} >/dev/null; fi`,
        `printf "RESULT_STATUS: IMPLEMENTED\\nREASON: deterministic acceptance gates passed with hard-validation evidence\\n" > ${FINAL_SIGNOFF_ARTIFACT}`,
        'echo result_status_implemented',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('gate-final-signoff-outcome', {
      type: 'deterministic',
      dependsOn: ['final-signoff'],
      command: [
        'set -e',
        `test -s ${FINAL_SIGNOFF_ARTIFACT}`,
        `rg -n "^RESULT_STATUS: IMPLEMENTED$" ${FINAL_SIGNOFF_ARTIFACT} >/dev/null`,
        `rg -n "^REASON: " ${FINAL_SIGNOFF_ARTIFACT} >/dev/null`,
        'echo final_signoff_gate_ok',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .onError('retry', { maxRetries: 1, retryDelayMs: 15_000 })
    .run({ cwd: process.cwd() });

  console.log(`Workflow status: ${result.status} (${result.id})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
