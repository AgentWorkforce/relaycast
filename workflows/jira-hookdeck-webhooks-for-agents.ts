/**
 * Jira + Hookdeck webhooks for agents
 *
 * Spec: docs/architecture/webhooks-for-agents-ingress.md
 *
 * Goal:
 *   Move from "we receive provider webhooks" to "agents declare the
 *   provider events they want, Cloud owns the registration, durable ingress,
 *   normalization, replay, and structured notification channel."
 *
 * Current executable slice:
 *   - Jira forwarded webhooks route through Cloud and RelayFile.
 *   - Hookdeck can forward the same Nango envelope to Cloud.
 *
 * Next slice:
 *   - Compile webhook intent into provider/Nango/Hookdeck subscriptions.
 *   - Publish normalized notifications to Relaycast.
 */

import { workflow } from "@relayflows/core";

async function main() {
  const result = await workflow("jira-hookdeck-webhooks-for-agents")
    .description("Wire Jira webhook ingress, Hookdeck edge ingress, and the next intent-to-subscription path")
    .pattern("dag")
    .channel("wf-jira-hookdeck")
    .maxConcurrency(2)
    .timeout(1_200_000)

    .agent("lead", {
      cli: "codex",
      role: "Owns the spec-to-implementation translation and reviews provider privacy constraints",
      preset: "lead",
      retries: 1,
      permissions: {
        access: "readonly",
        files: {
          read: [
            "docs/architecture/webhooks-for-agents-ingress.md",
            "packages/web/app/api/v1/webhooks/**",
            "packages/web/lib/integrations/**",
            "tests/*webhook*.test.ts",
          ],
          write: [],
          deny: [],
        },
        exec: ["rg", "sed", "npm"],
      },
    })

    .agent("impl", {
      cli: "codex",
      role: "Implements bounded Cloud webhook ingress changes",
      preset: "worker",
      retries: 2,
      permissions: {
        access: "restricted",
        files: {
          read: [
            "packages/web/app/api/v1/webhooks/**",
            "packages/web/lib/integrations/**",
            "tests/**",
          ],
          write: [
            "packages/web/app/api/v1/webhooks/**",
            "packages/web/lib/integrations/**",
            "tests/**",
          ],
          deny: ["infra/**", ".env*", "packages/web/drizzle/**"],
        },
        exec: ["npm", "npx", "rg", "sed"],
      },
    })

    .step("read-spec", {
      type: "deterministic",
      command: "sed -n '1,220p' docs/architecture/webhooks-for-agents-ingress.md",
      captureOutput: true,
      failOnError: true,
    })

    .step("inspect-router", {
      type: "deterministic",
      command: "rg -n \"routeForwardEvent|handleJiraForward|handleLinearForward|handleNangoWebhookPost|hookdeck\" packages/web/app/api/v1/webhooks packages/web/lib/integrations tests",
      captureOutput: true,
      failOnError: true,
    })

    .step("implementation-review", {
      agent: "lead",
      dependsOn: ["read-spec", "inspect-router"],
      task: `Review the Jira + Hookdeck webhook implementation against the spec.

Spec:
{{steps.read-spec.output}}

Router surface:
{{steps.inspect-router.output}}

Check:
1. Jira webhook data written to RelayFile excludes personal profile fields.
2. Hookdeck endpoint preserves the same Nango signature verification path.
3. The implementation remains a bounded ingress slice and does not pretend to implement the future agent intent compiler.
4. Tests cover Jira direct ingest and Hookdeck ingress routing.

Output IMPLEMENTATION_REVIEW_COMPLETE with any findings.`,
      verification: { type: "output_contains", value: "IMPLEMENTATION_REVIEW_COMPLETE" },
    })

    .step("verify", {
      type: "deterministic",
      dependsOn: ["implementation-review"],
      command: "npx vitest run tests/nango-webhook-router-fanout.test.ts tests/hookdeck-webhook-route.test.ts",
      captureOutput: true,
      failOnError: true,
    })

    .run({ cwd: process.cwd() });

  console.log("Result:", result.status);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
