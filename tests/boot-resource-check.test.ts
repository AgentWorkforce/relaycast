import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `Resource` from sst is a proxy that throws on missing keys at
// runtime. The cloud webapp imports it directly, so we mock the whole
// module per-test to drive each branch of the boot check.
const resourceProxyMock = vi.hoisted(() => ({ get current() { return {} as Record<string, unknown>; } }));

vi.mock("sst", () => ({
  get Resource() {
    // Re-evaluate the proxy on every read so each test can swap it
    // through `setResource()` without re-importing the module under
    // test.
    return new Proxy(
      {},
      {
        get: (_t, key: string) => {
          const target = resourceProxyMock.current;
          if (!(key in target)) {
            throw new Error(`Missing resource: ${key}`);
          }
          return target[key];
        },
      },
    );
  },
}));

function setResource(values: Record<string, unknown>): void {
  Object.defineProperty(resourceProxyMock, "current", {
    configurable: true,
    get: () => values,
  });
}

const CF_CONTEXT_SYMBOL = Symbol.for("__cloudflare-context__");

function setCloudflareContext(env: Record<string, unknown> | null): void {
  const slot = globalThis as Record<symbol, unknown>;
  if (env === null) {
    delete slot[CF_CONTEXT_SYMBOL];
    return;
  }
  slot[CF_CONTEXT_SYMBOL] = { env };
}

// All required resources bound with healthy values — used as a base
// from which each test omits or weakens a single resource.
const FULL_BINDINGS = {
  AuthSessionSecret: { value: "auth" },
  BrokerHmacSecret: { value: "broker-hmac" },
  BrokerKeySecret: { value: "broker" },
  CloudAgentSpawnQuotaDefault: { value: "8" },
  CloudTeamLaunchN1Enabled: { value: "true" },
  GithubInstallationCentric: { value: "true" },
  SlackConversationRoutingEnabled: { value: "disabled" },
  CredentialEncryptionKey: { value: "cred" },
  DaytonaApiKey: { value: "daytona" },
  GoogleClientId: { value: "google-id" },
  GoogleClientSecret: { value: "google-secret" },
  ComposioApiKey: { value: "composio" },
  DigestFunctionSigningKey: { value: "digest" },
  DropboxAppSecret: { value: "dropbox" },
  HookdeckSigningSecret: { value: "hookdeck" },
  HouseAnthropicKey: { value: "anthropic" },
  HouseGoogleKey: { value: "google" },
  HouseOpenaiKey: { value: "openai" },
  HouseOpenrouterKey: { value: "openrouter" },
  NangoSecretKey: { value: "nango" },
  NeonDatabaseUrl: { value: "postgres://user:pw@ep.neon.tech/db?sslmode=require" },
  AgentGatewayInternalSecret: { value: "agent-gateway" },
  RelayfileInternalHmacSecret: { value: "relayfile" },
  RelaycronApiKey: { value: "relaycron" },
  WebRelayauthApiKey: { value: "relayauth" },
  SageCloudApiToken: { value: "sage" },
  SageSupermemoryApiKey: { value: "supermemory" },
  WorkflowStorage: { bucketName: "workflow-bucket" },
  GithubCloneQueue: { url: "https://sqs.example/queue/github-clone" },
  WorkflowLaunchQueue: { url: "https://sqs.example/queue/workflow-launch" },
};

const FULL_WORKER_CF_BINDINGS = {
  // NOTE: the database is no longer a CF binding (HYPERDRIVE was removed when
  // the DB moved to Neon — it's now the NeonDatabaseUrl SST secret in
  // FULL_BINDINGS, checked on both runtimes).
  ROUTER_CONFIG: { get: () => undefined },
  RATE_LIMIT_COUNTERS: { get: () => undefined },
  WORKFLOW_STORAGE_R2: { get: () => undefined },
  WORKER_SELF_REFERENCE: { fetch: () => undefined },
  AGENT_GATEWAY_DEDUPE_BROKER: { fetch: () => undefined },
  PERSONA_COMPILE_WORKER: { fetch: () => undefined },
  CLOUD_AGENT_WARM_QUEUE: { send: () => undefined },
  NANGO_SYNC_WORKFLOW: { create: () => undefined },
  WORKFLOW_STORAGE_BACKEND: "r2",
  WORKFLOW_STORAGE_R2_BUCKET: "workflow-bucket",
  BROKER_URL: "https://broker.example",
  BROKER_HMAC_SECRET: "broker-hmac",
  QUEUE_BRIDGE_URL: "https://queue-bridge.example",
  QUEUE_BRIDGE_HMAC_SECRET: "queue-bridge-hmac",
  AGENT_GATEWAY_BASE_URL: "https://api.agentgateway.dev",
  AGENT_GATEWAY_INTERNAL_SECRET: "agent-gateway",
};

describe("checkRequiredResources (lambda runtime)", () => {
  let mod: typeof import("../packages/web/lib/boot/resource-check");

  beforeEach(async () => {
    setCloudflareContext(null);
    mod = await import("../packages/web/lib/boot/resource-check");
    mod.resetBootCheckForTests();
  });

  afterEach(() => {
    setResource({});
    setCloudflareContext(null);
    vi.restoreAllMocks();
  });

  it("returns every required resource as ok when all are bound (secrets non-empty, queues/buckets present)", () => {
    setResource(FULL_BINDINGS);

    const summary = mod.checkRequiredResources();
    expect(summary.runtime).toBe("lambda");
    expect(summary.missing).toEqual([]);
    expect(summary.ok.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        "NangoSecretKey",
        "AgentGatewayInternalSecret",
        "WorkflowStorage",
        "GithubCloneQueue",
      ]),
    );
  });

  it("flags secrets where the proxy throws (binding not attached at all)", () => {
    const { NangoSecretKey: _omit, ...rest } = FULL_BINDINGS;
    setResource(rest);

    const summary = mod.checkRequiredResources();
    const missing = summary.missing.find((entry) => entry.name === "NangoSecretKey");
    expect(missing).toBeDefined();
    expect(missing?.kind).toBe("secret");
    if (missing?.status === "missing") {
      expect(missing.reason).toMatch(/Missing resource: NangoSecretKey/);
    }
  });

  it("flags secrets bound with an empty value (the prod NangoSecretKey case — bound but unset for the stage)", () => {
    setResource({ ...FULL_BINDINGS, NangoSecretKey: { value: "" } });

    const summary = mod.checkRequiredResources();
    const missing = summary.missing.find((entry) => entry.name === "NangoSecretKey");
    expect(missing).toBeDefined();
    if (missing?.status === "missing") {
      expect(missing.reason).toMatch(/empty/);
    }
  });

  it("flags non-secret resources (queue, bucket) when the binding itself is missing", () => {
    const { WorkflowStorage: _bucket, GithubCloneQueue: _q2, ...rest } = FULL_BINDINGS;
    setResource(rest);

    const summary = mod.checkRequiredResources();
    const missingNames = summary.missing.map((entry) => entry.name);
    expect(missingNames).toEqual(
      expect.arrayContaining(["WorkflowStorage", "GithubCloneQueue"]),
    );
    // `kind: binding` resources don't have `.value` — they should NOT
    // get rejected for missing-value reasons. Only "binding not
    // attached" should mark them missing.
    for (const name of ["WorkflowStorage", "GithubCloneQueue"] as const) {
      const entry = summary.missing.find((m) => m.name === name);
      expect(entry?.kind).toBe("binding");
      if (entry?.status === "missing") {
        expect(entry.reason).not.toMatch(/empty/);
      }
    }
  });

  it("marks non-secret resources ok even when they have no `.value` field — the binding itself is sufficient", () => {
    setResource({
      ...FULL_BINDINGS,
      WorkflowStorage: { bucketName: "x" }, // no .value, that's fine
      GithubCloneQueue: { arn: "arn:aws:sqs:..." }, // arbitrary shape, still bound
    });

    const summary = mod.checkRequiredResources();
    expect(summary.missing).toEqual([]);
  });

  it("does NOT include CF Worker bindings (ROUTER_CONFIG, RATE_LIMIT_COUNTERS, WORKER_SELF_REFERENCE) on the Lambda — those bindings only exist on the Worker", () => {
    setResource(FULL_BINDINGS);

    const summary = mod.checkRequiredResources();
    const checkedNames = new Set([
      ...summary.ok.map((entry) => entry.name),
      ...summary.missing.map((entry) => entry.name),
    ]);
    for (const cfBinding of ["ROUTER_CONFIG", "RATE_LIMIT_COUNTERS", "WORKER_SELF_REFERENCE"]) {
      expect(checkedNames.has(cfBinding)).toBe(false);
    }
  });

  it("includes NeonDatabaseUrl as a shared SST secret on the Lambda", () => {
    setResource(FULL_BINDINGS);

    const summary = mod.checkRequiredResources();
    expect(summary.ok.map((entry) => entry.name)).toContain("NeonDatabaseUrl");
  });
});

describe("checkRequiredResources (worker runtime)", () => {
  let mod: typeof import("../packages/web/lib/boot/resource-check");

  beforeEach(async () => {
    // Set the CF context BEFORE importing the module — `detectRuntime`
    // reads the symbol on every call, but we want each test to start
    // from a known runtime regardless of the previous test's state.
    setCloudflareContext(FULL_WORKER_CF_BINDINGS);
    mod = await import("../packages/web/lib/boot/resource-check");
    mod.resetBootCheckForTests();
  });

  afterEach(() => {
    setResource({});
    setCloudflareContext(null);
    vi.restoreAllMocks();
  });

  it("detects the Worker runtime via the __cloudflare-context__ symbol and returns runtime: 'worker'", () => {
    setResource(FULL_BINDINGS);

    const summary = mod.checkRequiredResources();
    expect(summary.runtime).toBe("worker");
  });

  it("returns every required resource as ok when SST secrets and CF Worker bindings are all attached", () => {
    setResource(FULL_BINDINGS);

    const summary = mod.checkRequiredResources();
    expect(summary.missing).toEqual([]);
    expect(summary.ok.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        // Shared SST secrets are still required on the Worker
        "NangoSecretKey",
        // The database is a shared SST secret on the Worker too now
        "NeonDatabaseUrl",
        "DropboxAppSecret",
        "AuthSessionSecret",
        "AgentGatewayInternalSecret",
        // Shared SST-linked resources
        "WorkflowStorage",
        "GithubCloneQueue",
        // CF Worker bindings (kind: cf-binding) — Worker-only
        "ROUTER_CONFIG",
        "RATE_LIMIT_COUNTERS",
        "WORKER_SELF_REFERENCE",
        "PERSONA_COMPILE_WORKER",
        "CLOUD_AGENT_WARM_QUEUE",
        "AGENT_GATEWAY_BASE_URL",
        "AGENT_GATEWAY_INTERNAL_SECRET",
      ]),
    );
  });

  it("flags missing CF Worker bindings (e.g. ROUTER_CONFIG drift between infra/web-worker.ts appendWorkerBindings and the deployed Worker)", () => {
    setResource(FULL_BINDINGS);
    const { ROUTER_CONFIG: _omit, ...rest } = FULL_WORKER_CF_BINDINGS;
    setCloudflareContext(rest);

    const summary = mod.checkRequiredResources();
    const missingNames = summary.missing.map((entry) => entry.name);
    expect(missingNames).toContain("ROUTER_CONFIG");
    const routerConfig = summary.missing.find((entry) => entry.name === "ROUTER_CONFIG");
    expect(routerConfig?.kind).toBe("cf-binding");
    if (routerConfig?.status === "missing") {
      expect(routerConfig.reason).toMatch(/CF Worker binding not attached/);
    }
  });

  it("flags every CF Worker binding as missing when the Cloudflare env is empty (binding-table drift on the deployed Worker)", () => {
    setResource(FULL_BINDINGS);
    setCloudflareContext({});

    const summary = mod.checkRequiredResources();
    const missingNames = summary.missing.map((entry) => entry.name);
    expect(missingNames).toEqual(
      expect.arrayContaining([
        "ROUTER_CONFIG",
        "RATE_LIMIT_COUNTERS",
        "WORKER_SELF_REFERENCE",
        "PERSONA_COMPILE_WORKER",
        "CLOUD_AGENT_WARM_QUEUE",
      ]),
    );
  });

  it("still flags missing SST secrets on the Worker (NangoSecretKey-class regression on the Worker `link:` array)", () => {
    const { NangoSecretKey: _omit, ...rest } = FULL_BINDINGS;
    setResource(rest);

    const summary = mod.checkRequiredResources();
    const missing = summary.missing.find((entry) => entry.name === "NangoSecretKey");
    expect(missing).toBeDefined();
    expect(missing?.kind).toBe("secret");
  });
});

describe("runBootResourceCheck", () => {
  let mod: typeof import("../packages/web/lib/boot/resource-check");

  beforeEach(async () => {
    setCloudflareContext(null);
    mod = await import("../packages/web/lib/boot/resource-check");
    mod.resetBootCheckForTests();
  });

  afterEach(() => {
    setResource({});
    setCloudflareContext(null);
    vi.restoreAllMocks();
  });

  it("logs a single console.info on the happy path", () => {
    setResource(FULL_BINDINGS);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const summary = mod.runBootResourceCheck();
    expect(summary.missing).toEqual([]);
    expect(info).toHaveBeenCalledWith(
      "[boot] resource binding check passed",
      expect.objectContaining({
        runtime: "lambda",
        checked: expect.any(Array),
      }),
    );
    expect(error).not.toHaveBeenCalled();
  });

  it("logs a structured console.error when a binding is missing — operators see this in CloudWatch on first invoke", () => {
    const { NangoSecretKey: _omit, ...rest } = FULL_BINDINGS;
    setResource(rest);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const summary = mod.runBootResourceCheck();
    expect(summary.missing.map((entry) => entry.name)).toContain("NangoSecretKey");
    expect(error).toHaveBeenCalledWith(
      "[boot] resource binding check FAILED — required resources are not attached to this lambda",
      expect.objectContaining({
        runtime: "lambda",
        missing: expect.arrayContaining([
          expect.objectContaining({ name: "NangoSecretKey", status: "missing" }),
        ]),
        hint: expect.stringContaining("SST_RESOURCE_"),
      }),
    );
  });

  it("logs a Worker-specific FAILED message and hint when a CF binding is missing on the Worker runtime", () => {
    setResource(FULL_BINDINGS);
    const { ROUTER_CONFIG: _omit, ...rest } = FULL_WORKER_CF_BINDINGS;
    setCloudflareContext(rest);
    mod.resetBootCheckForTests();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const summary = mod.runBootResourceCheck();
    expect(summary.runtime).toBe("worker");
    expect(summary.missing.map((entry) => entry.name)).toContain("ROUTER_CONFIG");
    expect(error).toHaveBeenCalledWith(
      "[boot] resource binding check FAILED — required resources are not attached to this worker",
      expect.objectContaining({
        runtime: "worker",
        missing: expect.arrayContaining([
          expect.objectContaining({ name: "ROUTER_CONFIG", status: "missing", kind: "cf-binding" }),
        ]),
        hint: expect.stringContaining("appendWorkerBindings"),
      }),
    );
  });

  it("returns the cached first-run summary on subsequent invocations (warm-invoke handlers should see the real boot result)", () => {
    const { NangoSecretKey: _omit, ...rest } = FULL_BINDINGS;
    setResource(rest);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const first = mod.runBootResourceCheck();
    const second = mod.runBootResourceCheck();
    const third = mod.runBootResourceCheck();
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(first.missing.map((entry) => entry.name)).toContain("NangoSecretKey");
    // Critically: the cached call must NOT erase the missing entries.
    expect(second.missing.length).toBeGreaterThan(0);
  });

  it("only logs once per cold start (subsequent calls don't re-emit duplicate warnings)", () => {
    setResource({});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    mod.runBootResourceCheck();
    const callsAfterFirst = error.mock.calls.length;
    mod.runBootResourceCheck();
    mod.runBootResourceCheck();
    expect(error.mock.calls.length).toBe(callsAfterFirst);
  });
});
