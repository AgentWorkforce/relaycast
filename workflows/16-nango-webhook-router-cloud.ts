/**
 * V2-16: Unified Nango Webhook Router in Cloud
 *
 * Nango sends ALL integration webhooks to a single URL. Cloud needs a
 * unified endpoint that inspects the payload and routes to the right handler.
 *
 * Current state:
 *   - Cloud has /api/v1/webhooks/github (GitHub-specific)
 *   - Sage has /api/webhooks/slack (Slack-specific, via Nango forward)
 *   - No unified endpoint
 *
 * After this:
 *   - Nango global webhook URL: https://agentrelay.com/api/v1/webhooks/nango
 *   - Cloud routes by provider:
 *     slack → forward to Sage at sage.agentrelay.com/api/webhooks/slack
 *     github → existing GitHub webhook handler (RelayFile ingestion)
 *     notion → RelayFile ingestion (future)
 *     linear → RelayFile ingestion (future)
 *   - Also handles Nango lifecycle events (auth, sync completion)
 *
 * Sage's /api/webhooks/slack stays as-is — it already unwraps Nango envelopes.
 * Cloud just becomes the single entry point that forwards to the right service.
 *
 * Repos touched:
 *   cloud/packages/web/ — add unified webhook route
 *   sage/ — update .env.example docs only (no code changes)
 */

import { workflow } from '@relayflows/core';

async function main() {
  const result = await workflow('sage-v2-16-nango-webhook-router')
    .description('Add unified Nango webhook router to cloud — single URL for all integrations')
    .pattern('dag')
    .channel('wf-sage-v2-16')
    .maxConcurrency(2)
    .timeout(1_200_000)

    .agent('lead', {
      cli: 'claude',
      role: 'Reviews existing webhook routes and designs the unified router',
      preset: 'lead',
      retries: 1,
      permissions: {
        access: 'readonly',
        files: { read: ['packages/web/**', '../sage/src/server.ts'], write: [], deny: [] },
        exec: [],
      },
    })

    .agent('impl', {
      cli: 'codex',
      role: 'Implements the unified Nango webhook route in cloud',
      preset: 'worker',
      retries: 2,
      permissions: {
        access: 'restricted',
        files: {
          read: ['packages/web/**', '../sage/src/server.ts'],
          write: ['packages/web/app/api/v1/webhooks/nango/route.ts', 'packages/web/lib/integrations/nango-webhook-router.ts'],
          deny: ['packages/web/app/api/v1/webhooks/github/**', 'infra/**', '.env*', '**/*.test.ts'],
        },
        exec: [],
      },
    })

    .agent('reviewer', {
      cli: 'claude',
      role: 'Reviews the webhook router',
      preset: 'reviewer',
      retries: 1,
      permissions: {
        access: 'readonly',
        files: { read: ['packages/web/**'], write: [], deny: [] },
        exec: [],
      },
    })

    // ─── Read context ───────────────────────────────────────

    .step('read-github-webhook', {
      type: 'deterministic',
      command: 'cat packages/web/app/api/v1/webhooks/github/route.ts | head -40',
      captureOutput: true, failOnError: true,
    })

    .step('read-sage-slack-handler', {
      type: 'deterministic',
      command: 'grep -A5 'webhooks/slack' ../sage/src/server.ts | head -10',
      captureOutput: true, failOnError: true,
    })

    .step('read-nango-service', {
      type: 'deterministic',
      command: 'cat packages/web/lib/integrations/nango-service.ts 2>/dev/null | head -40',
      captureOutput: true, failOnError: false,
    })

    // ─── Plan ───────────────────────────────────────────────

    .step('plan', {
      agent: 'lead',
      dependsOn: ['read-github-webhook', 'read-sage-slack-handler', 'read-nango-service'],
      task: `Design the unified Nango webhook router for cloud.

Existing GitHub webhook:
{{steps.read-github-webhook.output}}

Sage Slack handler:
{{steps.read-sage-slack-handler.output}}

Nango service:
{{steps.read-nango-service.output}}

Nango sends webhooks with this envelope:
{
  "from": "slack",              // provider name
  "type": "forward",            // or "auth", "sync"
  "providerConfigKey": "slack", // integration config key
  "connectionId": "conn-123",   // which connection
  "payload": { ... }            // provider-specific event
}

DESIGN:

1. cloud/packages/web/app/api/v1/webhooks/nango/route.ts
   POST handler:
   a. Parse the Nango envelope
   b. Verify Nango webhook signature (X-Nango-Signature header, HMAC with NANGO_SECRET_KEY)
   c. Route by type:
      - "forward": route by provider (from field)
        - "slack" → forward to Sage: POST https://sage.agentrelay.com/api/webhooks/slack
        - "github" → call existing GitHub webhook handler logic
        - "notion" → store in RelayFile (future, return 200 for now)
        - "linear" → store in RelayFile (future, return 200 for now)
      - "auth": handle connection lifecycle (connected, disconnected)
        - Update workspace integration status
      - "sync": handle sync completion notifications
        - Log for now, future: trigger RelayFile ingestion
   d. Return 200 quickly (process async where possible)

2. cloud/packages/web/lib/integrations/nango-webhook-router.ts
   Helper functions:
   - verifyNangoWebhookSignature(body, headers, secretKey): boolean
   - routeNangoWebhook(envelope): Promise<void>
   - forwardToSage(envelope): Promise<void>
     Forwards the full envelope to Sage's webhook endpoint
     Uses internal service URL (not public, if both in same VPC)

3. Sage URL config:
   - Cloud needs to know Sage's webhook URL
   - Use SAGE_WEBHOOK_URL env var or derive from sage.agentrelay.com
   - For dev: http://localhost:3777

NANGO GLOBAL WEBHOOK URL to configure in Nango dashboard:
   https://agentrelay.com/api/v1/webhooks/nango

Output PLAN_COMPLETE when done.`,
      verification: { type: 'output_contains', value: 'PLAN_COMPLETE' },
    })

    // ─── Build ──────────────────────────────────────────────

    .step('implement', {
      agent: 'impl',
      dependsOn: ['plan'],
      task: `Implement the unified Nango webhook router.

Plan:
{{steps.plan.output}}

Create:
1. packages/web/app/api/v1/webhooks/nango/route.ts — POST handler
2. packages/web/lib/integrations/nango-webhook-router.ts — helpers

IMPORTANT: Write both files to disk. Do NOT output to stdout.`,
      verification: { type: 'file_exists', value: 'packages/web/app/api/v1/webhooks/nango/route.ts' },
    })

    // ─── Verify + Review ────────────────────────────────────

    .step('verify', {
      type: 'deterministic',
      dependsOn: ['implement'],
      command: [
        'test -f packages/web/app/api/v1/webhooks/nango/route.ts',
        'test -f packages/web/lib/integrations/nango-webhook-router.ts',
        'echo "NANGO_ROUTER_VERIFIED"',
      ].join(' && '),
      captureOutput: true, failOnError: true,
    })

    .step('review', {
      agent: 'reviewer',
      dependsOn: ['verify'],
      task: `Review the Nango webhook router.

Check:
1. Nango signature verification correct (HMAC-SHA256)?
2. Routes by provider correctly (slack → Sage, github → existing handler)?
3. Handles auth + sync events (not just forwards)?
4. Returns 200 quickly (async processing)?
5. Sage URL configurable (not hardcoded)?
6. Unknown providers handled gracefully (log + 200)?

Output REVIEW_COMPLETE with findings.`,
      verification: { type: 'output_contains', value: 'REVIEW_COMPLETE' },
    })

    .run({ cwd: process.cwd() });
  console.log('Result:', result.status);
}
main().catch(console.error);
