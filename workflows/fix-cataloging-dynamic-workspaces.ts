import { workflow } from "@relayflows/core";

const WORKSPACE_INTEGRATIONS = "packages/web/lib/integrations/workspace-integrations.ts";
const REQUEST_AUTH = "packages/web/lib/auth/request-auth.ts";
const INTERNAL_CATALOG_ROUTE = "packages/web/app/api/internal/cataloging/workspaces/[provider]/route.ts";
const INTERNAL_ROUTE_TEST = "tests/cataloging-workspace-route.test.ts";
const CATALOG_CORE_CONFIG = "packages/cataloging-agent-core/src/config.ts";
const CATALOG_CORE_WORKER = "packages/cataloging-agent-core/src/worker.ts";
const CATALOG_CORE_TEST = "packages/cataloging-agent-core/src/worker.test.ts";
const CATALOG_GITHUB_INDEX = "packages/cataloging-agent-github/src/index.ts";
const CATALOG_LINEAR_INDEX = "packages/cataloging-agent-linear/src/index.ts";
const INFRA_SECRETS = "infra/secrets.ts";
const INFRA_GITHUB = "infra/cataloging-agent-github.ts";
const INFRA_LINEAR = "infra/cataloging-agent-linear.ts";
const SEED_SCRIPT = ".github/scripts/seed-sst-secrets.sh";
const ARCH_DOC = "docs/architecture/cataloging-dynamic-workspace-discovery.md";

async function runWorkflow() {
  const result = await workflow("fix-cataloging-dynamic-workspaces")
    .description(
      "Replace static cataloging workspace env secrets with dynamic workspace discovery from cloud integration state.",
    )
    .pattern("dag")
    .channel("wf-cataloging-dynamic-workspaces")
    .maxConcurrency(3)
    .timeout(3_600_000)

    .agent("impl-web", { cli: "codex", preset: "worker", retries: 2 })
    .agent("impl-workers", { cli: "codex", preset: "worker", retries: 2 })
    .agent("impl-infra", { cli: "codex", preset: "worker", retries: 2 })
    .agent("tester", { cli: "codex", preset: "worker", retries: 2 })
    .agent("reviewer", { cli: "claude", preset: "worker", retries: 1 })

    .step("guard-clean-tree", {
      type: "deterministic",
      command:
        "bash -lc 'if [ -n \"$(git status --porcelain)\" ]; then echo \"Worktree must be clean before running this workflow\" >&2; git status --short; exit 1; fi'",
    })

    .step("read-architecture-doc", {
      type: "deterministic",
      command: `cat ${ARCH_DOC}`,
      captureOutput: true,
    })
    .step("read-workspace-integrations", {
      type: "deterministic",
      command: `cat ${WORKSPACE_INTEGRATIONS}`,
      captureOutput: true,
    })
    .step("read-request-auth", {
      type: "deterministic",
      command: `cat ${REQUEST_AUTH}`,
      captureOutput: true,
    })
    .step("read-internal-route-reference", {
      type: "deterministic",
      command: "cat packages/web/app/api/internal/relayfile/writeback/route.ts",
      captureOutput: true,
    })
    .step("read-catalog-core-config", {
      type: "deterministic",
      command: `cat ${CATALOG_CORE_CONFIG}`,
      captureOutput: true,
    })
    .step("read-catalog-core-worker", {
      type: "deterministic",
      command: `cat ${CATALOG_CORE_WORKER}`,
      captureOutput: true,
    })
    .step("read-catalog-core-test", {
      type: "deterministic",
      command: `cat ${CATALOG_CORE_TEST}`,
      captureOutput: true,
    })
    .step("read-catalog-worker-entrypoints", {
      type: "deterministic",
      command: `printf '%s\n\n%s\n' \"--- ${CATALOG_GITHUB_INDEX} ---\" \"$(cat ${CATALOG_GITHUB_INDEX})\" && printf '\n%s\n\n%s\n' \"--- ${CATALOG_LINEAR_INDEX} ---\" \"$(cat ${CATALOG_LINEAR_INDEX})\"`,
      captureOutput: true,
    })
    .step("read-catalog-infra", {
      type: "deterministic",
      command: `printf '%s\n\n%s\n' \"--- ${INFRA_GITHUB} ---\" \"$(cat ${INFRA_GITHUB})\" && printf '\n%s\n\n%s\n' \"--- ${INFRA_LINEAR} ---\" \"$(cat ${INFRA_LINEAR})\"`,
      captureOutput: true,
    })
    .step("read-secrets-and-seeding", {
      type: "deterministic",
      command: `printf '%s\n\n%s\n' \"--- ${INFRA_SECRETS} ---\" \"$(cat ${INFRA_SECRETS})\" && printf '\n%s\n\n%s\n' \"--- ${SEED_SCRIPT} ---\" \"$(cat ${SEED_SCRIPT})\"`,
      captureOutput: true,
    })

    .step("implement-cloud-discovery-route", {
      agent: "impl-web",
      dependsOn: [
        "guard-clean-tree",
        "read-architecture-doc",
        "read-workspace-integrations",
        "read-request-auth",
        "read-internal-route-reference",
      ],
      task: `Implement dynamic workspace discovery in cloud web.

Use the architecture doc as the source of truth:
{{steps.read-architecture-doc.output}}

Current workspace integration helper:
{{steps.read-workspace-integrations.output}}

Current request auth:
{{steps.read-request-auth.output}}

Reference internal route:
{{steps.read-internal-route-reference.output}}

Make the minimal additive changes needed to:

1. Add a helper in ${WORKSPACE_INTEGRATIONS} that lists unique connected workspace ids for a provider.
2. Extend ${REQUEST_AUTH} so cloud can authenticate a dedicated cataloging service token independently from Sage.
3. Create ${INTERNAL_CATALOG_ROUTE} that:
   - accepts only service auth for the dedicated cataloging token
   - validates provider path param to github|linear
   - returns stable JSON with provider + workspace ids from workspace_integrations
   - rejects invalid providers and unauthorized requests correctly
4. Add ${INTERNAL_ROUTE_TEST} with focused coverage for auth + provider filtering.

Constraints:
- Do not reuse Sage-only naming for the new token.
- Keep the route internal and read-only.
- Do not leave TODO-only stubs.
- Make the implementation production-ready, not a mock.
`,
    })
    .step("verify-cloud-discovery-route", {
      type: "deterministic",
      dependsOn: ["implement-cloud-discovery-route"],
      command: `bash -lc 'test -f "${INTERNAL_CATALOG_ROUTE}" && grep -q "CatalogingCloudApiToken" "${REQUEST_AUTH}" && grep -Eq "list.*workspace.*provider|workspace.*provider.*list" "${WORKSPACE_INTEGRATIONS}" && grep -q "provider" "${INTERNAL_CATALOG_ROUTE}"'`,
    })

    .step("implement-catalog-worker-discovery", {
      agent: "impl-workers",
      dependsOn: [
        "verify-cloud-discovery-route",
        "read-architecture-doc",
        "read-catalog-core-config",
        "read-catalog-core-worker",
        "read-catalog-core-test",
        "read-catalog-worker-entrypoints",
      ],
      task: `Replace static cataloging workspace discovery with dynamic cloud discovery.

Architecture:
{{steps.read-architecture-doc.output}}

Current core config:
{{steps.read-catalog-core-config.output}}

Current worker:
{{steps.read-catalog-core-worker.output}}

Current worker tests:
{{steps.read-catalog-core-test.output}}

Current package entrypoints:
{{steps.read-catalog-worker-entrypoints.output}}

Edit the cataloging runtime so:

1. The workers no longer depend on CATALOG_WORKSPACES for normal operation.
2. The package entrypoints provide a workspaceList implementation that fetches
   the internal cloud route for their provider using a dedicated cloud API URL
   and cataloging service token.
3. The fetch path validates the response shape and fails loudly on bad data.
4. ${CATALOG_CORE_TEST} is updated to prove ensure-subscriptions iterates the
   fetched dynamic workspace list rather than the old static env list.

Constraints:
- Keep the runtime provider-agnostic in cataloging-agent-core where possible.
- Do not shell out from inside the worker.
- Do not leave the old CATALOG_WORKSPACES path as the primary behavior.
`,
    })
    .step("verify-catalog-worker-discovery", {
      type: "deterministic",
      dependsOn: ["implement-catalog-worker-discovery"],
      command: `bash -lc 'grep -q "fetch(" "${CATALOG_GITHUB_INDEX}" && grep -q "fetch(" "${CATALOG_LINEAR_INDEX}" && grep -q "workspaceList" "${CATALOG_GITHUB_INDEX}" && grep -q "workspaceList" "${CATALOG_LINEAR_INDEX}" && ! grep -q "CATALOG_WORKSPACES: \\\"" "${CATALOG_GITHUB_INDEX}" && ! grep -q "CATALOG_WORKSPACES: \\\"" "${CATALOG_LINEAR_INDEX}"'`,
    })

    .step("implement-infra-cleanup", {
      agent: "impl-infra",
      dependsOn: [
        "verify-catalog-worker-discovery",
        "read-secrets-and-seeding",
        "read-catalog-infra",
      ],
      task: `Clean up the infrastructure and seeding path for dynamic cataloging discovery.

Current secrets + seed script:
{{steps.read-secrets-and-seeding.output}}

Current cataloging infra:
{{steps.read-catalog-infra.output}}

Update:

1. ${INFRA_SECRETS}
   - add a dedicated CatalogingCloudApiToken secret
2. ${INFRA_GITHUB} and ${INFRA_LINEAR}
   - remove static workspace secret injection
   - bind the cloud app URL and dedicated cataloging token instead
3. ${SEED_SCRIPT}
   - stop requiring CATALOGING_GITHUB_WORKSPACES and CATALOGING_LINEAR_WORKSPACES
   - require the dedicated cataloging service token instead

Constraints:
- Remove the static workspace secret path cleanly; do not leave dead config behind.
- Preserve the existing cataloging credential bindings that are still needed.
- Keep naming consistent across infra, env, and worker code.
`,
    })
    .step("verify-infra-cleanup", {
      type: "deterministic",
      dependsOn: ["implement-infra-cleanup"],
      command: `bash -lc '! rg -n "CatalogingGithubWorkspaces|CatalogingLinearWorkspaces|CATALOGING_GITHUB_WORKSPACES|CATALOGING_LINEAR_WORKSPACES" "${INFRA_GITHUB}" "${INFRA_LINEAR}" "${SEED_SCRIPT}" >/dev/null && rg -n "CatalogingCloudApiToken|CATALOGING_CLOUD_API_TOKEN" "${INFRA_SECRETS}" "${INFRA_GITHUB}" "${INFRA_LINEAR}" "${SEED_SCRIPT}" >/dev/null'`,
    })

    .step("run-targeted-tests", {
      type: "deterministic",
      dependsOn: ["verify-infra-cleanup"],
      command: `bash -lc 'npx vitest run "${INTERNAL_ROUTE_TEST}" "${CATALOG_CORE_TEST}"'`,
      captureOutput: true,
    })
    .step("fix-targeted-tests", {
      agent: "tester",
      dependsOn: ["run-targeted-tests"],
      task: `The targeted tests failed.

Failure output:
{{steps.run-targeted-tests.output}}

If the output already shows a clean pass, make no changes and say so briefly.
Otherwise, fix only the implementation and tests needed to make the targeted
cataloging workspace-discovery coverage pass. Do not broaden scope.`,
    })
    .step("run-targeted-tests-final", {
      type: "deterministic",
      dependsOn: ["run-targeted-tests", "fix-targeted-tests"],
      command: `bash -lc 'npx vitest run "${INTERNAL_ROUTE_TEST}" "${CATALOG_CORE_TEST}"'`,
      captureOutput: true,
    })

    .step("run-build-and-regressions", {
      type: "deterministic",
      dependsOn: ["run-targeted-tests-final"],
      command:
        "bash -lc 'npm run -w @cloud/cataloging-agent-core test:run && npm run -w @cloud/core build && npx tsc --noEmit -p packages/web/tsconfig.json'",
      captureOutput: true,
    })
    .step("fix-build-and-regressions", {
      agent: "tester",
      dependsOn: ["run-build-and-regressions"],
      task: `The final validation tail failed.

Output:
{{steps.run-build-and-regressions.output}}

If the output already shows a clean pass, make no changes and say so briefly.
Otherwise, fix the implementation with the smallest correct change set, then stop.`,
    })
    .step("run-build-and-regressions-final", {
      type: "deterministic",
      dependsOn: ["run-build-and-regressions", "fix-build-and-regressions"],
      command:
        "bash -lc 'npm run -w @cloud/cataloging-agent-core test:run && npm run -w @cloud/core build && npx tsc --noEmit -p packages/web/tsconfig.json'",
      captureOutput: true,
    })

    .step("review-change", {
      agent: "reviewer",
      dependsOn: ["run-build-and-regressions-final"],
      task: `Review the finished implementation for the dynamic cataloging workspace-discovery slice.

Required review bar:
- static cataloging workspace secrets are gone
- dedicated cataloging service auth is used
- discovery is driven from workspace_integrations
- targeted tests and final validation are green

Reply with exactly one of:
- APPROVED: <short rationale>
- CHANGES_REQUESTED: <short rationale>`,
    })
    .step("verify-review-approved", {
      type: "deterministic",
      dependsOn: ["review-change"],
      command: `bash -lc 'printf "%s" "{{steps.review-change.output}}" | grep -q "^APPROVED:"'`,
    })

    .step("commit", {
      type: "deterministic",
      dependsOn: ["verify-review-approved"],
      command:
        `bash -lc 'git add "${WORKSPACE_INTEGRATIONS}" "${REQUEST_AUTH}" "${INTERNAL_CATALOG_ROUTE}" "${INTERNAL_ROUTE_TEST}" "${CATALOG_CORE_CONFIG}" "${CATALOG_CORE_WORKER}" "${CATALOG_CORE_TEST}" "${CATALOG_GITHUB_INDEX}" "${CATALOG_LINEAR_INDEX}" "${INFRA_SECRETS}" "${INFRA_GITHUB}" "${INFRA_LINEAR}" "${SEED_SCRIPT}" && git commit -m "fix(cataloging): discover workspaces from cloud integrations"'`,
      captureOutput: true,
    })
    .run();

  if (result.status === "failed") {
    process.exit(1);
  }
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
