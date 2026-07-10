/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "cloud",
      // `remove` (not `retain`) on production too, so dropping resources (e.g.
      // the decommissioned admin + AWS Lambda web apps) actually deletes them
      // and their domains instead of leaving orphaned/retained infra.
      removal: "remove",
      home: "aws",
      providers: {
        cloudflare: "6.13.0",
      },
    };
  },
  async run() {
    const { assertStageAccount } = await import("./infra/account");
    await assertStageAccount();
    const { normalizedStage } = await import("./infra/foundation");
    const relayfileDeployDisabled =
      normalizedStage === "production" &&
      process.env.CLOUD_RELAYFILE_DEPLOY_DISABLED === "1";

    await import("./infra/secrets");
    await import("./infra/storage");
    await import("./infra/traffic-recorder");
    await import("./infra/credential-refresh");
    await import("./infra/stuck-run-reaper");
    await import("./infra/agent-deployment-run-retention");
    // CF Account API token used by GitHub Actions CI ("Cloud Github CI Token",
    // cfat_ prefix). The resource uses inline `import:` to adopt the
    // existing token rather than create a new one, plus `ignoreChanges: ["*"]`
    // so Pulumi tracks the token's existence without trying to reconcile its
    // policies against the live state (avoids chicken-and-egg: the token is
    // what CI uses to manage CF resources, including itself).
    //
    // Zero Trust organization is intentionally NOT declared in IaC. The
    // CF Pulumi provider's ZeroTrustOrganization resource doesn't support
    // `pulumi import`, and Zero Trust enable is a one-time account bootstrap
    // (per docs/setup/cloudflare-zero-trust.md) that doesn't benefit from
    // IaC management.
    await import("./infra/cloudflare-api-token");
    await import("./infra/observability");
    // STS broker must materialize before the cloud-web Worker because
    // web-worker.ts wires `BROKER_URL` from the broker's Function URL.
    // Pulumi will reorder if needed but importing in the right order
    // makes the dependency obvious to anyone reading sst.config.ts.
    await import("./infra/sts-broker");
    // Queue bridge must materialize before the cloud-web Worker because
    // web-worker.ts wires QUEUE_BRIDGE_URL from the bridge Function URL.
    // This lets Worker-served workflow launch routes enqueue SQS jobs without
    // ambient AWS IAM credentials.
    await import("./infra/queue-bridge");
    // Nango sync CF Workflow Worker. Must materialize before the cloud-web
    // Worker because web-worker.ts adds the NANGO_SYNC_WORKFLOW cross-script
    // workflow binding from this module.
    await import("./infra/nango-sync-workflow");
    // Dedicated internal Worker for proactive runtime delivery/dispatch paths.
    // Imported before cloud-web so the service-binding target exists on
    // phase-two deploys; no custom domains or apex routes are attached.
    await import("./infra/proactive-runtime-worker");
    // The Phase 3 cloud-web Worker. Ships dormant (router KV
    // `cloudOrigin` defaults to "lambda") but must be in the SST
    // module graph so the Worker resource + its bindings
    // materialize at deploy. Without this import the Worker is
    // declared but never created — verified by Codex P1.1 on PR #647.
    await import("./infra/web-worker");
    // Cloud-agent box warm queue + thin CF-native consumer Worker (issue #1384
    // slice 3a, option b). Also imported by web-worker.ts for the producer
    // binding; this explicit import keeps it visible in the module graph.
    // Ships dormant — nothing enqueues until CLOUD_AGENT_WARM_VIA_QUEUE flips on.
    await import("./infra/cloud-agent-warm-queue");
    // Dedicated private Worker for compiling hosted-agent persona bundles.
    // Integration with cloud-web's resolver route is intentionally deferred to
    // PR-B-integration after PR-A lands; this import only materializes the
    // standalone script and its runtime settings.
    await import("./infra/persona-compile-worker");
    await import("./infra/transcription-worker");
    const { neonDatabaseUrl } = await import("./infra/secrets");
    const { relaycast } = await import("./infra/relaycast");
    const relayfile = relayfileDeployDisabled
      ? undefined
      : (await import("./infra/relayfile")).relayfile;
    const { relayauth } = await import("./infra/relayauth");
    const { credentialProxy } = await import("./infra/credential-proxy");
    const { relaycron } = await import("./infra/relaycron");
    const { agentGateway } = await import("./infra/agent-gateway");
    const { transcriptionWorkerUrl } =
      await import("./infra/transcription-worker");

    // Sage is a singleton service — only the named Sage stages should
    // deploy the Fargate cluster + ALB + Cloudflare DNS entry + provision
    // production Slack/Nango credentials. Preview/ephemeral stages skip
    // the import entirely so they never touch Sage infra or secrets.
    // Paired with a matching stage allowlist in
    // .github/scripts/seed-sst-secrets.sh — both gates must agree for a
    // stage to get Sage; weakening either one alone does not expose it.
    //
    // Uses `normalizedStage` (not `$app.stage`) so that `--stage prod`
    // resolves the same as `--stage production` — matches the
    // normalization pattern established in infra/foundation.ts.
    //
    // TEMPORARILY DISABLED — see https://github.com/AgentWorkforce/cloud/pull/110
    // PR #97 added Sage with `image: { context: "../sage" }`, which expects a
    // sibling sage repo checkout on the deploy runner. The deploy.yml only
    // checks out cloud, so every dev/staging build fails at SST's Fargate
    // .dockerignore write step ("ENOENT ../sage/.dockerignore"), which then
    // skips the production deploy. This has broken the entire deploy pipeline
    // since #97 merged at 2026-04-09 13:09 UTC.
    //
    // The proper fix is to have the sage repo publish its image to GHCR and
    // switch infra/sage.ts to `image: { name: "ghcr.io/agentworkforce/sage:..." }`.
    // That work is tracked in a separate PR pair (sage publish workflow + cloud
    // image-name switch). When that lands, restore SAGE_STAGES to the original
    // ["production", "staging", "dev"] list.
    const SAGE_STAGES = ["production", "staging", "dev"] as const;
    const isSageStage = (SAGE_STAGES as readonly string[]).includes(
      normalizedStage,
    );
    const sage = isSageStage ? (await import("./infra/sage")).sage : undefined;
    const specialist = isSageStage
      ? (await import("./infra/specialist-worker")).specialist
      : undefined;
    // Cataloging agents share the same stage gating as Sage because they
    // depend on the same secrets (cataloging-specific OpenRouter keys + a
    // per-workspace list) that we don't seed into preview stages.
    const catalogingGithub = isSageStage
      ? (await import("./infra/cataloging-agent-github")).catalogingGithub
      : undefined;
    const catalogingLinear = isSageStage
      ? (await import("./infra/cataloging-agent-linear")).catalogingLinear
      : undefined;

    const { appUrl } = await import("./infra/web");

    if ($dev) {
      new sst.x.DevCommand("DB-Studio", {
        link: [neonDatabaseUrl],
        dev: {
          title: "Studio",
          autostart: false,
          command: "npx drizzle-kit studio --config ./drizzle.config.ts",
        },
      });
    }

    return {
      appUrl,
      ...(relaycast ? { relaycast } : {}),
      ...(relayfile ? { relayfile } : {}),
      ...(relayauth ? { relayauth } : {}),
      ...(credentialProxy ? { credentialProxy } : {}),
      ...(relaycron ? { relaycron } : {}),
      ...(agentGateway ? { agentGateway } : {}),
      transcriptionWorkerUrl,
      ...(sage ? { sage } : {}),
      ...(specialist ? { specialist } : {}),
      ...(catalogingGithub ? { catalogingGithub } : {}),
      ...(catalogingLinear ? { catalogingLinear } : {}),
    };
  },
});
