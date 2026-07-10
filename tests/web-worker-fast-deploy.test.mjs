import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const REQUIRED_SECRET_ENVS = [
  "AUTH_SESSION_SECRET",
  "BROKER_KEY_SECRET",
  "BROKER_HMAC_SECRET",
  "CREDENTIAL_ENCRYPTION_KEY",
  "CREDENTIAL_PROXY_JWT_SECRET",
  "DAYTONA_API_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "RELAY_JWT_SECRET",
  "RELAYFILE_INTERNAL_HMAC_SECRET",
  "AGENT_GATEWAY_INTERNAL_SECRET",
  "NANGO_SECRET_KEY",
  "HOOKDECK_SIGNING_SECRET",
  "DROPBOX_APP_SECRET",
  "COMPOSIO_API_KEY",
  "NEON_APP_DATABASE_URL",
  "RELAYCRON_API_KEY",
  "SAGE_CLOUD_API_TOKEN",
  "SAGE_SUPERMEMORY_API_KEY",
  "SPECIALIST_CLOUD_API_TOKEN",
  "WEB_RELAYAUTH_API_KEY",
  "RELAYHISTORY_ASSERTION_RELAYAUTH_API_KEY",
  "CATALOGING_CLOUD_API_TOKEN",
  "DIGEST_FUNCTION_SIGNING_KEY",
];

function generatorEnv() {
  const env = {
    ...process.env,
    AWS_ACCOUNT_ID: "123456789012",
    BROKER_URL: "https://sts-broker.example.test/",
    QUEUE_BRIDGE_URL: "https://queue-bridge.example.test/",
    WORKFLOW_STORAGE_BUCKET: "workflow-storage-fixture",
    WORKFLOW_STORAGE_STS_ROLE_ARN: "arn:aws:iam::123456789012:role/workflow-storage",
    GITHUB_CLONE_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123/github-clone",
    WORKFLOW_LAUNCH_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123/workflow-launch",
  };

  for (const name of REQUIRED_SECRET_ENVS) {
    env[name] = `${name.toLowerCase().replaceAll("_", "-")}-fixture`;
  }

  return env;
}

function runGenerator() {
  const result = spawnSync("python3", [".github/scripts/generate-sst-secrets-json.py"], {
    cwd: REPO_ROOT,
    env: generatorEnv(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function readProductionWranglerConfig() {
  return readFileSync(
    new URL("../packages/web/wrangler.production.toml", import.meta.url),
    "utf8",
  );
}

function bindingBlock(config, section, binding) {
  const sectionPattern = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bindingPattern = binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = config.match(
    new RegExp(
      `\\[\\[${sectionPattern}\\]\\]\\s+binding = "${bindingPattern}"(?<body>[\\s\\S]*?)(?=\\n\\[\\[|\\n\\[|\\n[A-Z_][A-Z0-9_]* = |$)`,
    ),
  );
  return match?.[0] ?? "";
}

test("fast Worker deploy generator emits required Worker URL bindings", () => {
  const secrets = runGenerator();

  assert.equal(secrets.BROKER_URL, "https://sts-broker.example.test");
  assert.equal(secrets.QUEUE_BRIDGE_URL, "https://queue-bridge.example.test");
  assert.equal(secrets.BROKER_HMAC_SECRET, "broker-hmac-secret-fixture");
  assert.equal(secrets.QUEUE_BRIDGE_HMAC_SECRET, "broker-hmac-secret-fixture");

  const workflowStorage = JSON.parse(secrets.SST_RESOURCE_WorkflowStorage);
  assert.equal(workflowStorage.bucketName, "workflow-storage-fixture");
  assert.equal(workflowStorage.stsRoleArn, "arn:aws:iam::123456789012:role/workflow-storage");
});

test("sample fast Worker wrangler config resolves all placeholders", () => {
  const secrets = runGenerator();
  const workflowStorage = JSON.parse(secrets.SST_RESOURCE_WorkflowStorage);
  let config = readProductionWranglerConfig();

  config = config
    .replaceAll("__ROUTER_CONFIG_KV_ID__", "router-config-kv-fixture")
    .replaceAll("__RATE_LIMIT_COUNTERS_KV_ID__", "rate-limit-counters-kv-fixture")
    .replaceAll("__WORKFLOW_STORAGE_BUCKET__", workflowStorage.bucketName);

  assert.equal(config.includes("__"), false, config);
  assert.match(config, /WORKFLOW_STORAGE_BUCKET = "workflow-storage-fixture"/);
});

test("production fast Worker config mirrors required Cloudflare bindings", () => {
  const config = readProductionWranglerConfig();

  assert.match(bindingBlock(config, "kv_namespaces", "ROUTER_CONFIG"), /id = "__ROUTER_CONFIG_KV_ID__"/);
  assert.match(bindingBlock(config, "kv_namespaces", "RATE_LIMIT_COUNTERS"), /id = "__RATE_LIMIT_COUNTERS_KV_ID__"/);
  assert.match(bindingBlock(config, "r2_buckets", "WORKFLOW_STORAGE_R2"), /bucket_name = "workflow-storage"/);

  assert.match(bindingBlock(config, "services", "WORKER_SELF_REFERENCE"), /service = "cloud-web-worker"/);
  assert.match(bindingBlock(config, "services", "AGENT_GATEWAY_DEDUPE_BROKER"), /service = "agent-gateway"/);
  assert.match(bindingBlock(config, "services", "PERSONA_COMPILE_WORKER"), /service = "persona-compile-worker"/);
  assert.match(bindingBlock(config, "services", "PROACTIVE_RUNTIME_WORKER"), /service = "proactive-runtime-worker"/);

  assert.match(bindingBlock(config, "queues.producers", "CLOUD_AGENT_WARM_QUEUE"), /queue = "cloud-agent-warm"/);

  const workflowBlock = bindingBlock(config, "workflows", "NANGO_SYNC_WORKFLOW");
  assert.match(workflowBlock, /name = "nango-sync"/);
  assert.match(workflowBlock, /class_name = "NangoSyncWorkflow"/);
  assert.match(workflowBlock, /script_name = "nango-sync-workflow"/);
});
