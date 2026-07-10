/**
 * V5-04: Promote V5 sage personas into @agentworkforce/workload-router
 *
 * Runs as Wave 4 of the overnight executor, AFTER all other V5 workflows
 * complete. Goal: move the 4 V5 persona JSONs from
 *   ${SAGE}/internal/agent-relay/personas/
 * into
 *   ${WORKFORCE}/personas/
 * and wire them into the workload-router package so they become
 * first-class `PersonaIntent` values that cloud + sage workflows can
 * consume via `resolvePersonaByTier(intent, tier)`.
 *
 * The 4 personas being promoted:
 *   - sage-slack-egress-migrator.json   → intent: sage-slack-egress-migration
 *   - sage-proactive-rewirer.json       → intent: sage-proactive-rewire
 *   - cloud-slack-proxy-guard.json      → intent: cloud-slack-proxy-guard
 *   - agent-relay-e2e-conductor.json    → intent: sage-cloud-e2e-conduction
 *
 * Pre-existing complication: the workforce `personas/` directory currently
 * has 4 UNTRACKED persona JSONs (api-contract-reviewer, docker-stack-wrangler,
 * e2e-validator, integration-test-author) that are NOT in the
 * `exportNameMap` inside scripts/generate-personas.mjs. The generator
 * throws on any JSON it doesn't recognize, so a `npm run build` would fail
 * today regardless of what we add. This workflow MUST also register those
 * 4 pre-existing files in the same PR, otherwise nothing builds.
 *
 * Version bumping is INTENTIONALLY left manual — the user publishes.
 *
 * Terminal output:
 *   The workflow creates a branch `workflows/v5-promote-sage-personas` off
 *   main in the workforce repo, pushes it, and opens a DRAFT PR with
 *   `gh pr create --draft`. PR URL is captured into the workflow log.
 */

import { workflow } from '@relayflows/core';
import { CodexModels } from '@agent-relay/config';
import * as path from 'node:path';

const CLOUD = process.cwd();
const ROOT = path.resolve(CLOUD, '..');
const WORKFORCE = path.join(ROOT, 'workforce');
const SAGE = path.join(ROOT, 'sage-slack-envelope');

const BRANCH = 'workflows/v5-promote-sage-personas';

async function main() {
  const result = await workflow('v5-04-promote-personas-to-workforce')
    .description(
      'Promote V5 sage personas into @agentworkforce/workload-router as typed PersonaIntents'
    )
    .pattern('dag')
    .channel('wf-v5-04-promote-personas')
    .maxConcurrency(1)
    .timeout(1_800_000) // 30 min — mechanical edits + build + gh pr create

    .agent('promoter', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role:
        'Senior package maintainer for @agentworkforce/workload-router. Performs the mechanical work of promoting external persona JSONs into the router catalog: copy files, extend the exportNameMap, extend PERSONA_INTENTS, extend personaCatalog, extend the default routing profile, run the generator + typecheck + tests, branch off main, push, and open a draft PR.',
      retries: 1,
    })

    .step('promote', {
      agent: 'promoter',
      task: `You are promoting 4 new sage personas into the @agentworkforce/workload-router package so they become typed PersonaIntent values. This is mechanical plumbing — follow the recipe exactly, do not redesign anything.

## Absolute paths

- Cloud repo:     ${CLOUD}
- Sage repo:      ${SAGE}
- Workforce repo: ${WORKFORCE}
- Package dir:    ${WORKFORCE}/packages/workload-router
- Source JSONs:   ${SAGE}/internal/agent-relay/personas/
  - sage-slack-egress-migrator.json
  - sage-proactive-rewirer.json
  - cloud-slack-proxy-guard.json
  - agent-relay-e2e-conductor.json
- Target dir:     ${WORKFORCE}/personas/
- Generator:      ${WORKFORCE}/packages/workload-router/scripts/generate-personas.mjs
- Index source:   ${WORKFORCE}/packages/workload-router/src/index.ts
- Default profile JSON (if present): ${WORKFORCE}/packages/workload-router/routing-profiles/default.json

## Pre-existing state you MUST handle

The workforce generator throws on any JSON in \`personas/\` it doesn't have an entry for in \`exportNameMap\`. Before doing anything, run \`ls personas/*.json\` in ${WORKFORCE} and grep \`exportNameMap\` in scripts/generate-personas.mjs to verify every JSON on disk is already mapped. If you find unmapped JSONs that are NOT one of the 4 V5 sage personas you are promoting in this run, STOP — do not fabricate entries, do not delete files. Print "V5_PROMOTE_INCOMPLETE: unmapped personas in workforce/personas/ — human triage required" and exit.

## Recipe

### Step 1 — Create a clean branch in workforce
Run these in ${WORKFORCE}:
  git fetch origin
  git checkout main
  git pull --ff-only origin main
  git checkout -b ${BRANCH}

If the branch already exists locally, \`git branch -D ${BRANCH}\` and re-create.

### Step 2 — Copy the 4 sage personas into the workforce personas dir
For each of the 4 sage files, cp it to ${WORKFORCE}/personas/<same-basename>. The file contents are authoritative — do not rewrite them.

### Step 3 — Read the \`intent\` field from the 4 sage files
For each of the 4 just-copied sage files, read the \`intent\` field from the JSON. These 4 strings are what you will add to \`PERSONA_INTENTS\` in src/index.ts. The expected values (verify by reading the files):
  - sage-slack-egress-migrator    → intent: "sage-slack-egress-migration"
  - sage-proactive-rewirer        → intent: "sage-proactive-rewire"
  - cloud-slack-proxy-guard       → intent: "cloud-slack-proxy-guard"
  - agent-relay-e2e-conductor     → intent: "sage-cloud-e2e-conduction"

### Step 4 — Extend scripts/generate-personas.mjs
Add 4 new entries to the \`exportNameMap\` Map (keep existing entries intact, preserve insertion order):

  ['sage-slack-egress-migrator', 'sageSlackEgressMigrator'],
  ['sage-proactive-rewirer', 'sageProactiveRewirer'],
  ['cloud-slack-proxy-guard', 'cloudSlackProxyGuard'],
  ['agent-relay-e2e-conductor', 'agentRelayE2eConductor'],

### Step 5 — Extend PERSONA_INTENTS in src/index.ts
Append the 4 intent strings (from step 3) to the end of the \`PERSONA_INTENTS\` tuple. Preserve all existing entries.

### Step 6 — Extend personaCatalog in src/index.ts
Add 4 new entries to the \`personaCatalog\` object literal, keyed by the intent string, mapping via \`parsePersonaSpec(<exportName>, '<intent>')\`. Example shape:
  'sage-slack-egress-migration': parsePersonaSpec(sageSlackEgressMigrator, 'sage-slack-egress-migration'),

Also import the 4 new constants at the top of src/index.ts from './generated/personas' (append to the existing import list).

### Step 7 — Extend the default routing profile (if it requires every intent)
Read ${WORKFORCE}/packages/workload-router/routing-profiles/default.json. If it has a \`rules\` / \`intents\` map keyed on PERSONA_INTENTS and is exhaustive, add the 4 new intents with a sensible default tier ('best-value') and a one-line \`rationale\`. If the profile is not exhaustive, skip this step. Prove exhaustiveness by reading the parser in src/index.ts.

### Step 8 — Regenerate + build + test
Run inside ${WORKFORCE}/packages/workload-router:
  npm run generate:personas
  npm run build
  npm test

All three MUST pass. If a test fails because it asserts a specific set of intents, extend the fixture. Do NOT skip or xfail tests.

### Step 9 — Commit, push, open draft PR
In ${WORKFORCE}:
  git add personas/ packages/workload-router/scripts/generate-personas.mjs packages/workload-router/src/index.ts packages/workload-router/src/generated/personas.ts packages/workload-router/routing-profiles/default.json
  git status
  git commit -m "feat(workload-router): register V5 sage personas as typed intents"
  git push -u origin ${BRANCH}

Then:
  gh pr create --draft \\
    --repo AgentWorkforce/workforce \\
    --base main \\
    --head ${BRANCH} \\
    --title "feat(workload-router): register V5 sage personas as typed intents" \\
    --body "<see body below>"

PR body (use a heredoc):

  ## Summary

  Registers 4 V5 sage personas into @agentworkforce/workload-router as typed PersonaIntent values so cloud + sage workflows can consume them via resolvePersonaByTier(intent, tier):

  - sage-slack-egress-migration
  - sage-proactive-rewire
  - cloud-slack-proxy-guard
  - sage-cloud-e2e-conduction

  ## Publish

  Version bump intentionally NOT included. Bump and publish manually after review:
    cd packages/workload-router
    npm version minor
    npm publish --access public

  ## Test plan
  - [x] npm run generate:personas
  - [x] npm run build
  - [x] npm test

  Generated from V5 overnight run (wave 4).

### Step 10 — Print PR URL
Capture the PR URL \`gh pr create\` prints and echo it with the prefix:
  V5_PROMOTE_PR_URL=<url>

## Success criteria
When everything above passes, print exactly:
  V5_PROMOTE_COMPLETE

If any step fails, print:
  V5_PROMOTE_INCOMPLETE: <one-line reason>
and exit 1.`,
      verification: { type: 'output_contains', value: 'V5_PROMOTE_COMPLETE' },
      retries: 1,
    })

    .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  console.log('Workflow status:', result.status);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
