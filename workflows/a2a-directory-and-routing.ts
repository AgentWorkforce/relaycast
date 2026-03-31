/**
 * a2a-directory-and-routing.ts
 *
 * Phases 3 + 5 of the A2A Platform (RFC 001): Agent Directory + Smart Routing
 *
 * Combined because routing depends on the directory's skill index.
 *
 * Implements:
 *   - Agent Directory: publish, search, browse, rate, certify badge
 *   - Smart Routing: skill-based matching, scoring algorithm, circuit breaker
 *   - AgentSkills integration: import from SKILL.md, index for matching
 *   - SDK: relay.route(), directory methods
 *
 * See: specs/001-a2a-platform.md (Sections 4, 7)
 *
 * Run: agent-relay run workflows/a2a-directory-and-routing.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';

async function main() {
const result = await workflow('a2a-directory-and-routing')
  .description('Agent Directory + Smart Routing — discover and route to agents by skill')
  .pattern('dag')
  .channel('wf-a2a-directory')
  .maxConcurrency(4)
  .timeout(3_600_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design directory schema, routing algorithm, skill indexing',
    cwd: RELAYCAST,
  })
  .agent('directory-dev', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement directory engine, routes, D1 schema',
    cwd: RELAYCAST,
  })
  .agent('routing-dev', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement routing engine, scoring, circuit breaker',
    cwd: RELAYCAST,
  })
  .agent('sdk-dev', {
    cli: 'codex',
    preset: 'worker',
    role: 'SDK updates: route(), directory methods, skill import',
    cwd: RELAYCAST,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Tests for directory and routing',
    cwd: RELAYCAST,
  })
  .agent('integrator', {
    cli: 'claude',
    preset: 'lead',
    role: 'Wire together, typecheck, run tests',
    cwd: RELAYCAST,
  })

  .step('read-spec', {
    type: 'deterministic',
    command: `cat ${RELAYCAST}/specs/001-a2a-platform.md`,
    captureOutput: true,
  })

  .step('read-existing-routes', {
    type: 'deterministic',
    command: `ls ${RELAYCAST}/packages/server/src/routes/ && echo "=== search ===" && cat ${RELAYCAST}/packages/server/src/routes/search.ts | head -40`,
    captureOutput: true,
  })

  .step('read-db-migrations', {
    type: 'deterministic',
    command: `ls ${RELAYCAST}/packages/server/src/db/migrations/`,
    captureOutput: true,
  })

  .step('read-command-engine', {
    type: 'deterministic',
    command: `cat ${RELAYCAST}/packages/server/src/engine/command.ts | head -80`,
    captureOutput: true,
  })

  .step('design', {
    agent: 'architect',
    dependsOn: ['read-spec', 'read-existing-routes', 'read-db-migrations', 'read-command-engine'],
    task: `Design the directory + routing implementation.

Spec Sections 4 (Directory) and 7 (Smart Routing):
{{steps.read-spec.output}}

Existing routes: {{steps.read-existing-routes.output}}
Existing migrations: {{steps.read-db-migrations.output}}
Command engine (skill-like pattern): {{steps.read-command-engine.output}}

Write ${RELAYCAST}/docs/a2a-directory-routing-implementation.md covering:

1. D1 migration for directory_entries table + skill_index table
2. Engine: directory.ts (CRUD, search via FTS5) + routing.ts (scoring, circuit breaker)
3. Routes: /v1/directory/*, /v1/route, /v1/skills/*, /v1/routing/config
4. Skill indexing: on agent registration, extract skills and index for fast lookup
5. Routing algorithm implementation (weights, scoring, fallback)
6. SDK methods: relay.route(), relay.searchDirectory(), relay.publishToDirectory()

Be specific about D1 FTS5 usage for text search and how skill embeddings
could work (but defer embedding-based matching to v2 — tag matching first).`,
    verification: { type: 'exit_code' },
  })

  .step('implement-directory', {
    agent: 'directory-dev',
    dependsOn: ['design'],
    task: `Implement the Agent Directory.

Design: {{steps.design.output}}

Create:
1. D1 migration for directory tables
2. ${RELAYCAST}/packages/server/src/engine/directory.ts — CRUD, search, ratings
3. ${RELAYCAST}/packages/server/src/routes/directory.ts — all /v1/directory/* routes

Follow existing engine/route patterns. Use D1 FTS5 for text search.
Write to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('implement-routing', {
    agent: 'routing-dev',
    dependsOn: ['design', 'implement-directory'],
    task: `Implement Smart Routing.

Design: {{steps.design.output}}

Create:
1. ${RELAYCAST}/packages/server/src/engine/routing.ts:
   - routeBySkill(workspaceId, skill, message) → { agentName, score, fallback }
   - Scoring algorithm from spec Section 7.3
   - Circuit breaker: track failures, exclude failing agents
   - Configurable weights per workspace
2. ${RELAYCAST}/packages/server/src/routes/routing.ts — /v1/route, /v1/skills/*, /v1/routing/config
3. Skill index: populate when agents register, query during routing

Write to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('update-sdk', {
    agent: 'sdk-dev',
    dependsOn: ['implement-routing', 'implement-directory'],
    task: `Add directory and routing methods to the TS SDK.

Add: route(), searchDirectory(), publishToDirectory(), importSkills(), getRoutingConfig(), updateRoutingConfig()

Follow existing SDK patterns. Write to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['implement-routing', 'implement-directory'],
    task: `Write tests for directory and routing.

Create ${RELAYCAST}/packages/server/src/__tests__/directory.test.ts:
- Publish/search/browse/rate directory entries
- FTS5 search matches on skills and descriptions

Create ${RELAYCAST}/packages/server/src/__tests__/routing.test.ts:
- Route by skill tag → correct agent
- Scoring with different weights
- Circuit breaker excludes failing agents
- Fallback when no agents match

Write to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('integrate', {
    agent: 'integrator',
    dependsOn: ['write-tests', 'update-sdk'],
    task: `Wire together, update worker.ts, typecheck, run tests. Fix any issues.`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: RELAYCAST,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\nDirectory + Routing workflow: ${result.status}`);
}

main().catch(console.error);
