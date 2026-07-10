/**
 * V5-02: Full sage ↔ cloud ↔ Slack End-to-End Validation
 *
 * The 80-to-100 tier layer: after v5-01 (sage migration) and v5-01 (cloud
 * proxy) both land, this workflow builds a docker-compose stack that runs
 * every service as a real process and drives a production-shaped
 * Slack app_mention fixture through the full wire path:
 *
 *   mock-slack (HTTP fake, records requests + returns prod-shaped bodies)
 *     ← miniflare-sage (runs @agentworkforce/sage in Workers runtime)
 *         ← cloud-web (Next.js, runs /api/v1/proxy/slack against real Postgres)
 *             ← postgres (real container, seeded with canonical workspace)
 *         + mock-nango (HTTP fake for Nango forward path + /auth/connection)
 *
 * Invariants proved:
 *   1. Webhook ingestion: mock-nango POSTs an app_mention to sage's
 *      /webhooks/nango endpoint; sage unwraps the envelope via
 *      @relayfile/adapters-slack parseSlackWebhookEnvelope.
 *   2. Egress hop-by-hop: sage → cloud-web /api/v1/proxy/slack → mock-slack
 *      chat.postMessage, with exact wire shape at each hop.
 *   3. Auth: cloud-web rejects requests with missing/wrong Bearer token
 *      (tested in the fixture driver with a control case).
 *   4. Provider resolution: sage NEVER sends providerConfigKey; cloud
 *      resolves it from the canonical team_id metadata.
 *   5. Error envelope: mock-slack returns ok:false on a control case;
 *      sage attempts a user-facing Slack reply and handles the failed post.
 *
 * Repos touched: cloud/ (compose + scripts + fixture driver)
 * Reads from:    ../sage/dist/ (prebuilt sage bundle)
 * Requires before: sage v5-01 + cloud v5-01 both merged.
 */

import { workflow } from '@relayflows/core';

const READ_GLOBS = [
  'packages/web/**',
  'infra/sage.ts',
  'infra/foundation.ts',
  'infra/web.ts',
  'scripts/**',
  'workflows/**',
  'package.json',
  'tests/**',
  '../sage/dist/**',
  '../sage/package.json',
  '../sage/src/types.ts',
  '../sage/src/app.ts',
  '../sage/src/integrations/**',
];

const DENY_GLOBS = [
  '.env*',
  'packages/web/.next/**',
  'packages/web/.open-next/**',
  '../sage/src/proactive/**',
];

async function main() {
  const result = await workflow('sage-cloud-v5-02-e2e')
    .description('Docker-compose E2E stack proving sage ↔ cloud ↔ Slack works end-to-end')
    .pattern('dag')
    .channel('wf-sage-cloud-e2e')
    .maxConcurrency(4)
    .timeout(7_200_000) // 120 min — real stack bring-up + fixture drive + teardown

    // ----- agents --------------------------------------------------------

    .agent('lead', {
      cli: 'claude',
      role: 'E2E conductor: specs stack topology, reviews mocks for fidelity, signs off on evidence',
      preset: 'lead',
      retries: 1,
      permissions: {
        access: 'readonly',
        files: { read: READ_GLOBS, write: [], deny: DENY_GLOBS },
        exec: ['git diff *', 'git status', 'cat *', 'ls *', 'grep *', 'docker compose config'],
      },
    })

    .agent('compose-impl', {
      cli: 'codex',
      role: 'Writes docker-compose.e2e.yml with pinned image tags and explicit healthchecks',
      preset: 'worker',
      retries: 2,
      permissions: {
        access: 'restricted',
        files: {
          read: READ_GLOBS,
          write: [
            'docker-compose.e2e.yml',
            'docker/e2e/**',
            '.dockerignore.e2e',
          ],
          deny: DENY_GLOBS,
        },
        exec: [],
      },
    })

    .agent('mock-slack-impl', {
      cli: 'codex',
      role: 'Writes the mock-slack HTTP server — production-shaped responses, request recorder',
      preset: 'worker',
      retries: 2,
      permissions: {
        access: 'restricted',
        files: {
          read: READ_GLOBS,
          write: ['docker/e2e/mock-slack/**'],
          deny: DENY_GLOBS,
        },
        exec: [],
      },
    })

    .agent('mock-nango-impl', {
      cli: 'codex',
      role: 'Writes the mock-nango HTTP server — forward webhook + /auth/connection',
      preset: 'worker',
      retries: 2,
      permissions: {
        access: 'restricted',
        files: {
          read: READ_GLOBS,
          write: ['docker/e2e/mock-nango/**'],
          deny: DENY_GLOBS,
        },
        exec: [],
      },
    })

    .agent('scripts-impl', {
      cli: 'codex',
      role: 'Writes bring-up/teardown/seed scripts and the fixture driver',
      preset: 'worker',
      retries: 2,
      permissions: {
        access: 'restricted',
        files: {
          read: READ_GLOBS,
          write: ['scripts/e2e/**', 'tests/e2e/**'],
          deny: DENY_GLOBS,
        },
        exec: [],
      },
    })

    .agent('e2e-fixer', {
      cli: 'codex',
      role: 'Reads captured E2E evidence and fixes wiring issues in mocks or scripts (not product code)',
      preset: 'worker',
      retries: 2,
      permissions: {
        access: 'restricted',
        files: {
          read: READ_GLOBS,
          write: ['docker/e2e/**', 'scripts/e2e/**', 'tests/e2e/**'],
          deny: DENY_GLOBS,
        },
        exec: [],
      },
    })

    // ----- read context --------------------------------------------------

    .step('read-sage-bundle', {
      type: 'deterministic',
      command: [
        'echo "=== sage package.json ==="',
        'cat ../sage/package.json',
        'echo "=== sage dist layout ==="',
        'ls -la ../sage/dist 2>/dev/null || echo "(no dist — run npm run build in sage first)"',
        'echo "=== sage types ==="',
        'cat ../sage/src/types.ts',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })

    .step('read-sage-app-entry', {
      type: 'deterministic',
      command: 'cat ../sage/src/app.ts',
      captureOutput: true,
      failOnError: true,
    })

    .step('read-sage-integrations', {
      type: 'deterministic',
      command: [
        'echo "=== cloud-proxy-provider ==="',
        'cat ../sage/src/integrations/cloud-proxy-provider.ts 2>/dev/null || echo "(not yet landed — sage v5-01 must run first)"',
        'echo "=== slack-egress ==="',
        'cat ../sage/src/integrations/slack-egress.ts 2>/dev/null || echo "(not yet landed)"',
        'echo "=== slack-ingress ==="',
        'cat ../sage/src/integrations/slack-ingress.ts 2>/dev/null || echo "(not yet landed)"',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })

    .step('read-cloud-proxy-route', {
      type: 'deterministic',
      command: 'cat packages/web/app/api/v1/proxy/slack/route.ts 2>/dev/null || echo "(not yet landed — cloud v5-01 must run first)"',
      captureOutput: true,
      failOnError: false,
    })

    .step('read-sage-infra', {
      type: 'deterministic',
      command: [
        'echo "=== infra/sage.ts ==="',
        'cat infra/sage.ts',
        'echo "=== deploy.yml env block ==="',
        'head -250 .github/workflows/deploy.yml',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })

    .step('read-prod-webhook-fixture', {
      type: 'deterministic',
      command: [
        'echo "=== looking for captured production webhook bodies ==="',
        'find . -name "*.json" -path "*fixture*" -o -name "*.json" -path "*webhook*" 2>/dev/null | head -20 || true',
        'grep -rln "app_mention" tests packages/web/tests ../sage/src 2>/dev/null | head -20 || true',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })

    // ----- lead: architecture spec ---------------------------------------

    .step('spec', {
      agent: 'lead',
      dependsOn: [
        'read-sage-bundle',
        'read-sage-app-entry',
        'read-sage-integrations',
        'read-cloud-proxy-route',
        'read-sage-infra',
        'read-prod-webhook-fixture',
      ],
      task: `You are the conductor for the full sage ↔ cloud ↔ Slack E2E.

Goal: build a docker-compose stack that reproduces production topology
faithfully enough to catch real wire-level bugs, then drive a
production-shaped Slack app_mention fixture through the stack and capture
hop-by-hop evidence.

Context:

  sage package.json + dist layout:
  {{steps.read-sage-bundle.output}}

  sage src/app.ts entry:
  {{steps.read-sage-app-entry.output}}

  sage integrations (must be landed before this runs):
  {{steps.read-sage-integrations.output}}

  cloud /api/v1/proxy/slack route (must be landed):
  {{steps.read-cloud-proxy-route.output}}

  sage SST infra (for binding names):
  {{steps.read-sage-infra.output}}

  Production-shaped fixture availability:
  {{steps.read-prod-webhook-fixture.output}}

Produce a spec covering:

1. Stack topology (docker-compose.e2e.yml)
   Services:
     - postgres:16.4-alpine (pinned, NOT :latest).
       Healthcheck: pg_isready -U e2e -d e2e — real protocol-level check, not tcp-accept.
       Env: POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB.
       Volume: none (ephemeral; seeded on up).
     - mock-slack: node:20.14-alpine running docker/e2e/mock-slack/server.js.
       Healthcheck: curl -f http://localhost:3001/__health or wget.
       Exposes 3001 → host 13001.
     - mock-nango: node:20.14-alpine running docker/e2e/mock-nango/server.js.
       Healthcheck: curl -f http://localhost:3002/__health.
       Exposes 3002 → host 13002.
     - mock-supermemory: node:20.14-alpine returning empty Supermemory
       document/search results. Healthcheck on /__health. Exposes 3003 → host 13003.
     - mock-openrouter: node:20.14-alpine returning deterministic router
       and synthesis responses. Healthcheck on /__health. Exposes 3004 → host 13004.
     - cloud-web: builds from docker/e2e/cloud-web.Dockerfile (multi-stage,
       pinned node base). Runs "npm run start" against packages/web on port 3000.
       Env: DATABASE_URL pointing at postgres service, CLOUD_API_TOKEN=e2e-secret, NANGO_BASE_URL=http://mock-nango:3002.
       depends_on: postgres (service_healthy).
       Healthcheck: curl -f http://localhost:3000/api/health.
     - miniflare-sage: node:20.14-alpine running the sage dev server from ../sage/src
       with secret_text bindings matching infra/sage.ts:
         OPENROUTER_API_KEY=e2e-fake
         OPENROUTER_ENDPOINT=http://mock-openrouter:3004/api/v1/chat/completions
         SUPERMEMORY_API_KEY=e2e-fake
         SUPERMEMORY_ENDPOINT=http://mock-supermemory:3003
         CLOUD_API_URL=http://cloud-web:3000
         CLOUD_API_TOKEN=e2e-secret
       depends_on: cloud-web, mock-slack, mock-nango, mock-openrouter,
       mock-supermemory (service_healthy).
       Exposes 8787 → host 18787.

   NO :latest tags. NO implicit ordering (always explicit healthchecks).
   NO TCP-only healthchecks (protocol-level required).

2. Bring-up / teardown (scripts/e2e/up.sh, down.sh, seed.sh)
   - up.sh: docker compose -f docker-compose.e2e.yml up -d --build --wait
     (the --wait flag blocks until all healthchecks pass).
   - seed.sh: runs after up.sh. Creates the e2e workspace + slack_integration
     row in postgres with canonical team_id metadata:
       INSERT INTO workspaces (id, name) VALUES ('a0000000-0000-4000-8000-000000000001', 'E2E Workspace');
       INSERT INTO slack_integrations (workspace_id, team_id, connection_id, provider_config_key)
         VALUES ('a0000000-0000-4000-8000-000000000001', 'T0E2E000', 'conn-e2e', 'slack-sage');
   - down.sh: docker compose -f docker-compose.e2e.yml down -v
     (removes volumes to leave no stray state).
   - Use bash -euo pipefail.
   - Document ports + workspace UUID in docker/e2e/README.md.

3. mock-slack (docker/e2e/mock-slack/server.js)
   - Plain Node HTTP server (no frameworks — tiny bundle).
   - Routes:
       GET  /__health                  → 200 { ok: true }
       POST /api/chat.postMessage      → 200 { ok: true, channel: req.body.channel, ts: "<now>", message: { type: "message", user: "U-BOT", ts: "<now>", text: req.body.text, team: "T0E2E000", bot_id: "B-E2E", bot_profile: { id: "B-E2E", name: "sage-e2e", app_id: "A-E2E" } } }
       POST /api/chat.postEphemeral    → same shape minus .message
       POST /api/reactions.add         → 200 { ok: true }
       POST /api/reactions.remove      → 200 { ok: true }
       GET  /api/conversations.replies → 200 { ok: true, messages: [], has_more: false }
       GET  /api/conversations.history → 200 { ok: true, messages: [], has_more: false }
       POST /api/auth.test             → 200 { ok: true, team: "T0E2E000", user: "U-BOT", bot_id: "B-E2E" }
       POST /__control/ok-false        → sets next call to return { ok: false, error: "rate_limited" }
       GET  /__recorder                → 200 [...recorded requests]
       POST /__reset                   → clears recorder + control state
   - Every request is recorded: { method, path, headers, body, ts }.
   - The body shape returned MUST match what real Slack returns — no simplified subsets.

4. mock-nango (docker/e2e/mock-nango/server.js)
  - Plain Node HTTP server.
   - Routes:
       GET  /__health                      → 200 { ok: true }
       GET  /connection/:connectionId       → 200 { connection_id, provider_config_key: "slack-sage", metadata: { team_id: "T0E2E000" } }
       POST /proxy/:endpoint                → forwards to mock-slack with the exact same body and returns mock-slack's response verbatim.
       POST /__inject-webhook              → fixture driver calls this to inject a Slack app_mention into sage by POSTing to miniflare-sage's webhook endpoint with the Nango forward envelope shape.
       GET  /__recorder                     → recorded requests
       POST /__reset                        → clears recorder

5. mock-supermemory + mock-openrouter
   - Plain Node HTTP servers.
   - mock-supermemory routes:
       GET  /__health             → 200 { ok: true }
       POST /v3/documents/list    → 200 { documents: [] }
       POST /v3/search            → 200 { results: [], documents: [] }
       POST /v3/documents         → 200 { id: "memory-e2e" }
       POST /v4/search            → 200 { results: [] }
   - mock-openrouter routes:
       GET  /__health                         → 200 { ok: true }
       POST /api/v1/chat/completions          → production-shaped OpenRouter response.
   - These mocks keep the Docker E2E deterministic and prevent fake API keys
     from making outbound network calls during the local validation.

6. Fixture driver (tests/e2e/drive-app-mention-fixture.ts)
   - Written in TypeScript, run via tsx.
   - Steps:
       1. POST /__reset to both mock servers.
       2. POST /__inject-webhook on mock-nango with a byte-identical
          production app_mention envelope (team_id T0E2E000, channel C-E2E,
          user U-HUMAN, text "<@U-BOT> hello", ts, event_ts).
       3. Wait for sage to process and call cloud-web proxy.
          Poll mock-slack /__recorder every 200ms up to 15s for a
          chat.postMessage call.
       4. Fetch evidence from each hop:
            - mock-nango /__recorder (sage pulled connection metadata)
            - cloud-web audit evidence via psql when an audit table exists
            - mock-slack /__recorder (final outbound chat.postMessage)
       5. Assert every invariant (see spec section 7) with clear PASS/FAIL.
       6. Write a JSON evidence file to .logs/e2e-<timestamp>.json.
   - Include a second control run that asserts:
       - Wrong Bearer token from sage-side → cloud returns 403.
       - mock-slack ok:false → sage attempts a user-facing Slack reply and handles the failed post.

7. Hard invariants (each has a matching assertion in the driver)
   a. mock-slack received exactly one chat.postMessage during the golden run.
   b. The chat.postMessage body contained channel="C-E2E" and text starting with a sage response (not the literal "<@U-BOT> hello").
   c. The chat.postMessage request was wrapped in the cloud proxy envelope (Authorization: Bearer e2e-secret on the hop FROM sage → cloud-web, NOT from cloud-web → mock-slack).
   d. The hop from cloud-web → mock-slack carried the providerConfigKey/connectionId internally (observable via mock-nango recorder and the seeded integration row).
   e. Sage source code (the running bundle path) contains no direct import of Nango's Node SDK — verified via grep against the sage package's package.json bundled deps list.
   f. If a postgres audit table exists, the audit row records reason='ok', httpStatus=200, and does NOT contain data.text; otherwise log-backed audit is recorded as an accepted branch state.
   g. Control case: wrong bearer → cloud-web returns 403 code='unauthorized', mock-slack recorder shows zero calls.
   h. Control case: ok:false → sage attempts at least one user-facing chat.postMessage and the failed Slack post is captured.

8. Wave plan
   Wave A (parallel, after spec):
     - compose-impl: docker-compose.e2e.yml + docker/e2e/cloud-web.Dockerfile + docker/e2e/miniflare-sage.Dockerfile + docker/e2e/README.md
     - mock-slack-impl: docker/e2e/mock-slack/{server.js, Dockerfile, package.json}
     - mock-nango-impl: docker/e2e/mock-nango/{server.js, Dockerfile, package.json}
   Wave B (after all of Wave A):
     - scripts-impl: scripts/e2e/{up.sh, down.sh, seed.sh} + tests/e2e/drive-app-mention-fixture.ts + tests/e2e/fixtures/app-mention.json
   Wave C (deterministic):
     - validate-compose: docker compose -f docker-compose.e2e.yml config (parses + lints)
     - bring-up: scripts/e2e/up.sh → seed.sh
     - drive-fixture: tsx tests/e2e/drive-app-mention-fixture.ts (golden + control cases)
     - capture-evidence: cat .logs/e2e-*.json
     - tear-down: scripts/e2e/down.sh (ALWAYS runs, even on failure)
   Wave D: e2e-fix (if needed) → re-run once → final-review

End with: SPEC_COMPLETE`,
      verification: { type: 'output_contains', value: 'SPEC_COMPLETE' },
    })

    // ----- Wave A (parallel) ---------------------------------------------

    .step('impl-compose', {
      agent: 'compose-impl',
      dependsOn: ['spec'],
      task: `Write the docker-compose stack per the spec:

{{steps.spec.output}}

Create:
  docker-compose.e2e.yml
  docker/e2e/cloud-web.Dockerfile
  docker/e2e/miniflare-sage.Dockerfile
  docker/e2e/README.md

Hard rules (verified by a gate):
  - No image tag is :latest.
  - postgres uses :16.4-alpine (exact).
  - node-based services use :20.14-alpine (exact).
  - Every service has an explicit healthcheck: directive with a
    protocol-level test command (pg_isready / curl / wget — NOT just
    tcp-accept).
  - depends_on uses { condition: service_healthy } form, not the
    implicit shorthand.
  - Ports are documented in README.md with exact host → container mapping.
  - cloud-web receives CLOUD_API_TOKEN=e2e-secret via environment.
  - miniflare-sage receives CLOUD_API_URL=http://cloud-web:3000 via environment.
  - No .env files referenced (secrets are inline in compose for e2e).

Write files to disk. Do NOT print contents to stdout.`,
      verification: { type: 'file_exists', value: 'docker-compose.e2e.yml' },
    })

    .step('verify-compose', {
      type: 'deterministic',
      dependsOn: ['impl-compose'],
      command: [
        'test -f docker-compose.e2e.yml',
        'test -f docker/e2e/cloud-web.Dockerfile',
        'test -f docker/e2e/miniflare-sage.Dockerfile',
        'test -f docker/e2e/README.md',
        '! grep -q ":latest" docker-compose.e2e.yml',
        '! grep -q ":latest" docker/e2e/cloud-web.Dockerfile',
        '! grep -q ":latest" docker/e2e/miniflare-sage.Dockerfile',
        'grep -q "postgres:16.4-alpine" docker-compose.e2e.yml',
        'grep -q "healthcheck" docker-compose.e2e.yml',
        'grep -q "pg_isready" docker-compose.e2e.yml',
        'grep -q "service_healthy" docker-compose.e2e.yml',
        'grep -q "CLOUD_API_TOKEN" docker-compose.e2e.yml',
        'grep -q "CLOUD_API_URL" docker-compose.e2e.yml',
        'echo COMPOSE_VERIFY_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('impl-mock-slack', {
      agent: 'mock-slack-impl',
      dependsOn: ['spec'],
      task: `Write the mock-slack HTTP server per the spec:

{{steps.spec.output}}

Create:
  docker/e2e/mock-slack/server.js
  docker/e2e/mock-slack/Dockerfile
  docker/e2e/mock-slack/package.json

Hard rules (verified by a gate):
  - server.js uses plain node:http — no express, fastify, or other frameworks.
  - Response body for /api/chat.postMessage matches the Slack production
    shape exactly: { ok: true, channel, ts, message: { type, user, ts, text, team, bot_id, bot_profile: { id, name, app_id } } }
  - server.js records every request as { method, path, headers, body, ts }.
  - /__recorder returns the recorded array.
  - /__reset clears the recorder AND the ok-false control state.
  - /__control/ok-false sets a one-shot flag that makes the next chat.postMessage return { ok: false, error: "rate_limited" }.
  - Dockerfile uses node:20.14-alpine (pinned).
  - Dockerfile HEALTHCHECK directive uses wget or curl against /__health.

Write files to disk. Do NOT print contents to stdout.`,
      verification: { type: 'file_exists', value: 'docker/e2e/mock-slack/server.js' },
    })

    .step('verify-mock-slack', {
      type: 'deterministic',
      dependsOn: ['impl-mock-slack'],
      command: [
        'test -f docker/e2e/mock-slack/server.js',
        'test -f docker/e2e/mock-slack/Dockerfile',
        'grep -q "node:http" docker/e2e/mock-slack/server.js',
        '! grep -q "express\\|fastify\\|koa" docker/e2e/mock-slack/server.js',
        'grep -q "bot_profile" docker/e2e/mock-slack/server.js',
        'grep -q "/api/chat.postMessage" docker/e2e/mock-slack/server.js',
        'grep -q "/api/reactions.add" docker/e2e/mock-slack/server.js',
        'grep -q "/api/conversations.replies" docker/e2e/mock-slack/server.js',
        'grep -q "/__recorder" docker/e2e/mock-slack/server.js',
        'grep -q "/__reset" docker/e2e/mock-slack/server.js',
        'grep -q "/__control/ok-false" docker/e2e/mock-slack/server.js',
        'grep -q "node:20.14-alpine" docker/e2e/mock-slack/Dockerfile',
        '! grep -q ":latest" docker/e2e/mock-slack/Dockerfile',
        'grep -q "HEALTHCHECK" docker/e2e/mock-slack/Dockerfile',
        'echo MOCK_SLACK_VERIFY_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('impl-mock-nango', {
      agent: 'mock-nango-impl',
      dependsOn: ['spec'],
      task: `Write the mock-nango HTTP server per the spec:

{{steps.spec.output}}

Create:
  docker/e2e/mock-nango/server.js
  docker/e2e/mock-nango/Dockerfile
  docker/e2e/mock-nango/package.json

Required routes:
  GET  /__health
  GET  /connection/:connectionId   → { connection_id, provider_config_key: 'slack-sage', metadata: { team_id: 'T0E2E000' } }
  POST /proxy/:endpoint            → forwards to http://mock-slack:3001/api/:endpoint
  POST /__inject-webhook           → POSTs a Slack app_mention envelope to http://miniflare-sage:8787/webhooks/nango
  GET  /__recorder
  POST /__reset

The /__inject-webhook body is the full Nango forward envelope:
  {
    type: 'forward',
    from: 'slack',
    connectionId: 'conn-e2e',
    providerConfigKey: 'slack-sage',
    payload: { team_id: 'T0E2E000', event: { type: 'app_mention', user: 'U-HUMAN', text: '<@U-BOT> hello', channel: 'C-E2E', ts: '1700000000.000100', event_ts: '1700000000.000100' } }
  }

Hard rules (verified by a gate):
  - Plain node:http, no frameworks.
  - Dockerfile uses node:20.14-alpine (pinned).
  - HEALTHCHECK directive against /__health.
  - /__inject-webhook POSTs to miniflare-sage service by hostname
    (http://miniflare-sage:8787), not localhost.

Write files to disk. Do NOT print contents to stdout.`,
      verification: { type: 'file_exists', value: 'docker/e2e/mock-nango/server.js' },
    })

    .step('verify-mock-nango', {
      type: 'deterministic',
      dependsOn: ['impl-mock-nango'],
      command: [
        'test -f docker/e2e/mock-nango/server.js',
        'test -f docker/e2e/mock-nango/Dockerfile',
        'grep -q "node:http" docker/e2e/mock-nango/server.js',
        '! grep -q "express\\|fastify\\|koa" docker/e2e/mock-nango/server.js',
        'grep -q "/connection/" docker/e2e/mock-nango/server.js',
        'grep -q "/__inject-webhook" docker/e2e/mock-nango/server.js',
        'grep -q "/__recorder" docker/e2e/mock-nango/server.js',
        'grep -q "/__reset" docker/e2e/mock-nango/server.js',
        'grep -q "miniflare-sage" docker/e2e/mock-nango/server.js',
        'grep -q "slack-sage" docker/e2e/mock-nango/server.js',
        'grep -q "node:20.14-alpine" docker/e2e/mock-nango/Dockerfile',
        '! grep -q ":latest" docker/e2e/mock-nango/Dockerfile',
        'echo MOCK_NANGO_VERIFY_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ----- Wave B (after all Wave A) -------------------------------------

    .step('impl-scripts', {
      agent: 'scripts-impl',
      dependsOn: ['verify-compose', 'verify-mock-slack', 'verify-mock-nango'],
      task: `Write bring-up scripts and the fixture driver per the spec:

{{steps.spec.output}}

Create:
  scripts/e2e/up.sh
  scripts/e2e/down.sh
  scripts/e2e/seed.sh
  scripts/e2e/run.sh          (orchestrator: up → seed → drive → capture → down)
  tests/e2e/drive-app-mention-fixture.ts
  tests/e2e/fixtures/app-mention.json

Hard rules (verified by a gate):
  - Every shell script starts with "#!/usr/bin/env bash" and "set -euo pipefail".
  - run.sh uses "trap scripts/e2e/down.sh EXIT" so teardown ALWAYS runs.
  - up.sh uses "docker compose -f docker-compose.e2e.yml up -d --build --wait".
  - down.sh uses "docker compose -f docker-compose.e2e.yml down -v".
  - seed.sh creates the workspace + slack_integration rows via psql against
    the postgres container (use docker compose exec).
  - The fixture driver uses tsx. It:
      (a) POSTs to mock-nango /__inject-webhook with the golden envelope,
      (b) polls mock-slack /__recorder for a chat.postMessage call,
      (c) checks postgres audit evidence when an audit table exists,
      (d) writes JSON evidence to .logs/e2e-<ts>.json,
      (e) asserts all 8 invariants,
      (f) runs the control cases (wrong bearer, ok:false).
  - tests/e2e/fixtures/app-mention.json contains the Nango forward envelope
    exactly as mock-nango /__inject-webhook expects it.

Write files to disk. Do NOT print contents to stdout.

Make the shell scripts executable:
  chmod +x scripts/e2e/up.sh scripts/e2e/down.sh scripts/e2e/seed.sh scripts/e2e/run.sh`,
      verification: { type: 'file_exists', value: 'scripts/e2e/run.sh' },
    })

    .step('verify-scripts', {
      type: 'deterministic',
      dependsOn: ['impl-scripts'],
      command: [
        'test -f scripts/e2e/up.sh',
        'test -f scripts/e2e/down.sh',
        'test -f scripts/e2e/seed.sh',
        'test -f scripts/e2e/run.sh',
        'test -f tests/e2e/drive-app-mention-fixture.ts',
        'test -f tests/e2e/fixtures/app-mention.json',
        'grep -q "set -euo pipefail" scripts/e2e/up.sh',
        'grep -q "set -euo pipefail" scripts/e2e/down.sh',
        'grep -q "set -euo pipefail" scripts/e2e/run.sh',
        'grep -q "docker compose -f docker-compose.e2e.yml up -d --build --wait" scripts/e2e/up.sh',
        'grep -q "docker compose -f docker-compose.e2e.yml down -v" scripts/e2e/down.sh',
        'grep -q "trap" scripts/e2e/run.sh',
        'grep -q "chat.postMessage\\|__recorder" tests/e2e/drive-app-mention-fixture.ts',
        'grep -q "__inject-webhook" tests/e2e/drive-app-mention-fixture.ts',
        'grep -q "T0E2E000" tests/e2e/fixtures/app-mention.json',
        'grep -q "app_mention" tests/e2e/fixtures/app-mention.json',
        'chmod +x scripts/e2e/up.sh scripts/e2e/down.sh scripts/e2e/seed.sh scripts/e2e/run.sh',
        'echo SCRIPTS_VERIFY_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ----- Wave C (deterministic stack bring-up + drive) -----------------

    .step('validate-compose-config', {
      type: 'deterministic',
      dependsOn: ['verify-scripts'],
      command: 'docker compose -f docker-compose.e2e.yml config --quiet',
      captureOutput: true,
      failOnError: true,
    })

    .step('build-sage-bundle', {
      type: 'deterministic',
      dependsOn: ['validate-compose-config'],
      command: 'cd ../sage && npm run build 2>&1 | tail -50',
      captureOutput: true,
      failOnError: true,
    })

    .step('e2e-run-first', {
      type: 'deterministic',
      dependsOn: ['build-sage-bundle'],
      command: 'mkdir -p .logs && bash scripts/e2e/run.sh 2>&1 | tee .logs/v5-02-e2e-first-run.log',
      captureOutput: true,
      failOnError: false,
    })

    .step('e2e-fix', {
      agent: 'e2e-fixer',
      dependsOn: ['e2e-run-first'],
      task: `Read the E2E first-run output. If it ended with "E2E_PASS",
print "NO_FIX_NEEDED" and stop.

Otherwise, decide whether the failure is:
  (a) wiring in mocks or scripts (docker/e2e/** or scripts/e2e/** or tests/e2e/**), OR
  (b) a real bug in sage or cloud product code.

Only fix category (a). For (b), print "PRODUCT_BUG: <file> <reason>" and stop.

E2E run output:
{{steps.e2e-run-first.output}}

Common wiring issues to check:
  - Healthcheck timing: postgres not ready when seed.sh runs.
  - Service DNS: mock-nango referring to "localhost" instead of "miniflare-sage".
  - Body encoding: mock-slack recorder stores Buffer instead of parsed JSON.
  - Port mismatch: compose expose vs script connect.
  - Missing sage bundle files in miniflare-sage container.
  - Wrong CLOUD_API_TOKEN value between sage and cloud-web.

You may NOT edit packages/web/** or ../sage/src/**.

Write fixes to disk. Do NOT print full file contents to stdout.`,
      verification: { type: 'exit_code' },
    })

    .step('e2e-rerun', {
      type: 'deterministic',
      dependsOn: ['e2e-fix'],
      command: 'bash scripts/e2e/run.sh 2>&1 | tee .logs/v5-02-e2e-rerun.log',
      captureOutput: true,
      failOnError: true,
    })

    .step('capture-evidence', {
      type: 'deterministic',
      dependsOn: ['e2e-rerun'],
      command: [
        'echo "=== latest evidence file ==="',
        'ls -lt .logs/e2e-*.json 2>/dev/null | head -3',
        'echo "---"',
        'cat $(ls -t .logs/e2e-*.json | head -1) 2>/dev/null || echo "(no evidence file written)"',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })

    // ----- final review --------------------------------------------------

    .step('final-review', {
      agent: 'lead',
      dependsOn: ['capture-evidence'],
      task: `Review the E2E run.

Compose validation:
{{steps.validate-compose-config.output}}

E2E first run:
{{steps.e2e-run-first.output}}

E2E fix outcome:
{{steps.e2e-fix.output}}

E2E rerun:
{{steps.e2e-rerun.output}}

Captured evidence:
{{steps.capture-evidence.output}}

For each invariant, report PASS or FAIL with evidence from the JSON file:

  1. mock-slack received exactly one chat.postMessage in the golden run.
  2. chat.postMessage body contained channel='C-E2E' and text that is NOT the literal input.
  3. Authorization: Bearer e2e-secret appeared on the sage → cloud-web hop, NOT on the cloud-web → mock-slack hop.
  4. cloud-web audit evidence was checked; if an audit table exists, it recorded reason='ok', httpStatus=200, and no data.text leak.
  5. Sage's running bundle has no Nango SDK runtime import.
  6. Control case (wrong bearer): cloud-web returned 403 code='unauthorized'; mock-slack recorder empty.
  7. Control case (ok:false): sage attempted at least one user-facing chat.postMessage and the failed Slack post was captured.
  8. Stack teardown ran cleanly (no stray containers, no leaked volumes).

Run these verifications yourself:
  docker ps -a --filter label=com.docker.compose.project=cloud
  docker volume ls --filter label=com.docker.compose.project=cloud
  ls -la .logs/e2e-*.json

Call out explicitly which services were mocked (mock-slack, mock-nango)
and which were real (postgres, cloud-web, miniflare-sage+sage bundle).

If all invariants pass, end with: E2E_VALIDATED`,
      verification: { type: 'output_contains', value: 'E2E_VALIDATED' },
    })

    .onError('retry', { maxRetries: 1, retryDelayMs: 15_000 })
    .run({ cwd: process.cwd() });

  console.log('Workflow status:', result.status);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
