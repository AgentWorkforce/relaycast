import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  launchOrchestratorSandbox,
  createDaytonaSandboxDetached,
  deriveInteractive,
  applyCredentialProxyEnv,
  resolveCredentialProxyConfig,
  pathsToEnvValue,
  resolveMultiPathWorkflowFile,
  buildMsdReviewInputJson,
  uploadLibDirectory,
} from "../../packages/core/src/bootstrap/launcher.js";
import type { CredentialBundle } from "../../packages/core/src/auth/credentials.js";
import { DEFAULT_SNAPSHOT } from "../../packages/core/src/config/snapshot.js";

const baseBundle: CredentialBundle = {
  s3Credentials: {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    sessionToken: "token",
    bucket: "test-bucket",
    prefix: "user-123/run-456",
  },
  cliCredentials: "{}",
  workspaceId: "ws-1",
  relayApiKey: "relay-key",
  relayBaseUrl: "https://relay.test",
  runId: "run-456",
  userId: "user-123",
};

const publicDirUrl = new URL("../../packages/web/public/", import.meta.url);
const publicTarballUrl = new URL("orchestrator-lib.tar.gz", publicDirUrl);
let originalPublicTarball: Buffer | null | undefined;

function removePublicTarballForTest(): void {
  if (originalPublicTarball !== undefined) return;
  originalPublicTarball = existsSync(publicTarballUrl)
    ? readFileSync(publicTarballUrl)
    : null;
  rmSync(publicTarballUrl, { force: true });
}

afterEach(() => {
  if (originalPublicTarball === undefined) return;
  if (originalPublicTarball) {
    mkdirSync(publicDirUrl, { recursive: true });
    writeFileSync(publicTarballUrl, originalPublicTarball);
  } else {
    rmSync(publicTarballUrl, { force: true });
  }
  originalPublicTarball = undefined;
});

function createUploadSandbox() {
  const uploadFileCalls: Array<[Buffer, string]> = [];
  const executeCommandCalls: Array<[string, string | undefined]> = [];
  const sandbox = {
    fs: {
      uploadFile: async (content: Buffer, destination: string) => {
        uploadFileCalls.push([content, destination]);
      },
    },
    process: {
      executeCommand: async (command: string, cwd?: string) => {
        executeCommandCalls.push([command, cwd]);
        return { exitCode: 0, result: "" };
      },
    },
  } as Parameters<typeof uploadLibDirectory>[0];

  return { sandbox, uploadFileCalls, executeCommandCalls };
}

describe("launchOrchestratorSandbox", () => {
  it("passes the pinned snapshot into Daytona detached createSandbox", async () => {
    const createCalls: Array<{ params: Record<string, unknown>; options?: unknown }> = [];
    const sandbox = {
      id: "sbx-started",
      state: "STARTED",
    };
    const daytona = {
      target: "us",
      sandboxApi: {
        createSandbox: async (
          params: Record<string, unknown>,
          _organizationId?: string,
          options?: unknown,
        ) => {
          createCalls.push({ params, options });
          return { data: { id: sandbox.id, state: "STARTED" } };
        },
      },
      get: async (id: string) => {
        assert.equal(id, sandbox.id);
        return sandbox;
      },
    };

    const result = await createDaytonaSandboxDetached({
      daytona: daytona as never,
      params: {
        snapshot: DEFAULT_SNAPSHOT,
        autoStopInterval: 60,
      },
      timeoutSeconds: 120,
    });

    assert.equal(result.id, sandbox.id);
    assert.deepEqual(createCalls, [
      {
        params: {
          snapshot: DEFAULT_SNAPSHOT,
          autoStopInterval: 60,
          env: {},
          labels: {
            "code-toolbox-language": "python",
          },
          target: "us",
        },
        options: { timeout: 15000 },
      },
    ]);
  });

  it("uploads provided orchestrator lib bytes before disk or URL fallback", async () => {
    removePublicTarballForTest();
    const providedBytes = new Uint8Array(Buffer.from("provided-tarball"));
    const diskBytes = Buffer.from("disk-tarball");
    mkdirSync(publicDirUrl, { recursive: true });
    writeFileSync(publicTarballUrl, diskBytes);
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response(Buffer.from("unexpected-fetch"));
    }) as typeof fetch;
    const { sandbox, uploadFileCalls } = createUploadSandbox();

    try {
      await uploadLibDirectory(
        sandbox,
        "/home/daytona",
        providedBytes,
        "https://agentrelay.test/cloud/orchestrator-lib.tar.gz",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(fetchCalled, false);
    assert.equal(uploadFileCalls.length, 1);
    assert.deepEqual(uploadFileCalls[0][0], Buffer.from(providedBytes));
    assert.equal(uploadFileCalls[0][1], "/home/daytona/orchestrator-lib.tar.gz");
  });

  it("uploads orchestrator lib from disk without fetching the asset URL", async () => {
    removePublicTarballForTest();
    const diskBytes = Buffer.from("disk-tarball");
    mkdirSync(publicDirUrl, { recursive: true });
    writeFileSync(publicTarballUrl, diskBytes);
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response(Buffer.from("unexpected-fetch"));
    }) as typeof fetch;
    const { sandbox, uploadFileCalls, executeCommandCalls } = createUploadSandbox();

    try {
      await uploadLibDirectory(
        sandbox,
        "/home/daytona",
        undefined,
        "https://agentrelay.test/cloud/orchestrator-lib.tar.gz",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(fetchCalled, false);
    assert.equal(uploadFileCalls.length, 1);
    assert.deepEqual(uploadFileCalls[0][0], diskBytes);
    assert.equal(uploadFileCalls[0][1], "/home/daytona/orchestrator-lib.tar.gz");
    assert.equal(executeCommandCalls.length, 1);
  });

  it("fetches orchestrator lib from the asset URL when disk candidates miss", async () => {
    removePublicTarballForTest();
    const fetchedBytes = Buffer.from("fetched-tarball");
    const fetchCalls: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalls.push(args[0]);
      return new Response(fetchedBytes, {
        status: 200,
        headers: { "content-type": "application/gzip" },
      });
    }) as typeof fetch;
    const { sandbox, uploadFileCalls } = createUploadSandbox();

    try {
      await uploadLibDirectory(
        sandbox,
        "/home/daytona",
        undefined,
        "https://agentrelay.test/cloud/orchestrator-lib.tar.gz",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.deepEqual(fetchCalls, [
      "https://agentrelay.test/cloud/orchestrator-lib.tar.gz",
    ]);
    assert.equal(uploadFileCalls.length, 1);
    assert.deepEqual(uploadFileCalls[0][0], fetchedBytes);
    assert.equal(uploadFileCalls[0][1], "/home/daytona/orchestrator-lib.tar.gz");
  });

  it("throws the fetch error when the orchestrator lib asset URL is not OK", async () => {
    removePublicTarballForTest();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("missing", {
        status: 503,
        statusText: "Service Unavailable",
      })) as typeof fetch;
    const { sandbox } = createUploadSandbox();

    try {
      await assert.rejects(
        () =>
          uploadLibDirectory(
            sandbox,
            "/home/daytona",
            undefined,
            "https://agentrelay.test/cloud/orchestrator-lib.tar.gz",
          ),
        {
          message:
            "Failed to fetch orchestrator-lib.tar.gz from https://agentrelay.test/cloud/orchestrator-lib.tar.gz: 503 Service Unavailable",
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws an explicit error when the credential bundle lacks Daytona auth", async () => {
    await assert.rejects(
      () =>
        launchOrchestratorSandbox({
          credentialBundle: {
            ...baseBundle,
            daytonaApiKey: "   ",
          },
          runId: "run-456",
          relayfileUrl: "http://localhost:9090",
          relayAuthUrl: "https://api.relayauth.test",
          relayAuthApiKey: "test-api-key",
          fileType: "config",
        }),
      {
        message: "Daytona auth is required in credential bundle",
      },
    );
  });

  it("adds generic proxy discovery env vars when both url + token are set", () => {
    const env: Record<string, string> = {
      RUN_ID: "run-456",
    };

    applyCredentialProxyEnv(
      env,
      resolveCredentialProxyConfig({
        credentialProxyUrl: "https://proxy.example.com/",
        credentialProxyToken: "proxy-token",
      }),
    );

    // Provider-specific base URL overrides (OPENAI_BASE_URL etc.) are NOT
    // written by applyCredentialProxyEnv — the credentialProxyTokens loop
    // in launchOrchestratorSandbox owns those via resolveProxyEnvForProvider.
    assert.deepEqual(env, {
      RUN_ID: "run-456",
      RELAY_LLM_PROXY: "https://proxy.example.com",
      RELAY_LLM_PROXY_URL: "https://proxy.example.com",
      CREDENTIAL_PROXY_TOKEN: "proxy-token",
      RELAY_LLM_PROXY_TOKEN: "proxy-token",
    });
  });

  it("no-ops when the proxy URL is configured but no token is available", () => {
    // Without a token, redirecting SDK env vars at the proxy would just
    // produce 401s. Cloud defaults CREDENTIAL_PROXY_URL even when no
    // workspace has a minted token, so guarding on token presence keeps
    // agents on their mounted upstream credentials.
    const env: Record<string, string> = { RUN_ID: "run-456" };

    applyCredentialProxyEnv(
      env,
      resolveCredentialProxyConfig({
        credentialProxyUrl: "https://proxy.example.com/",
        credentialProxyToken: "",
      }),
    );

    assert.deepEqual(env, { RUN_ID: "run-456" });
  });

  it("reserves credential proxy env vars in the workflow run API route", () => {
    const routeSource = readFileSync(
      new URL("../../packages/web/app/api/v1/workflows/run/route.ts", import.meta.url),
      "utf8",
    );

    for (const key of [
      "RESUME_RUN_ID",
      "START_FROM",
      "PREVIOUS_RUN_ID",
      "RELAY_LLM_PROXY",
      "RELAY_LLM_PROXY_URL",
      "OPENAI_BASE_URL",
      "ANTHROPIC_BASE_URL",
      "GOOGLE_API_BASE",
      "OPENAI_API_BASE",
      "CREDENTIAL_PROXY_TOKEN",
      "RELAY_LLM_PROXY_TOKEN",
    ]) {
      assert.match(routeSource, new RegExp(`"${key}"`));
    }
  });

  it("reserves shared-sandbox control env vars in the workflow run API route", () => {
    const routeSource = readFileSync(
      new URL("../../packages/web/app/api/v1/workflows/run/route.ts", import.meta.url),
      "utf8",
    );

    for (const key of [
      "WORKFLOW_EXECUTION_MODE",
      "WORKFLOW_OBSERVER_URL",
      "MSD_REVIEW_INPUT_JSON",
      "AGENT_WORKFORCE_SHARED_SANDBOX_ID",
      "AGENT_WORKFORCE_SHARED_WORKDIR",
    ]) {
      assert.match(routeSource, new RegExp(`"${key}"`));
    }
  });

  it("threads shared-sandbox metadata and the orchestrator sandbox id into bootstrap env", () => {
    const launcherSource = readFileSync(
      new URL("../../packages/core/src/bootstrap/launcher.ts", import.meta.url),
      "utf8",
    );

    assert.match(launcherSource, /export type WorkflowExecutionMode = "per-step-sandbox" \| "shared-sandbox"/);
    assert.match(launcherSource, /envVars\.WORKFLOW_EXECUTION_MODE = executionMode/);
    assert.match(launcherSource, /envVars\.DAYTONA_SANDBOX_ID = sandbox\.id/);
    assert.match(launcherSource, /envVars\.MSD_REVIEW_INPUT_JSON = buildMsdReviewInputJson\(/);
    assert.match(launcherSource, /normalizeSharedSandboxTtlMinutes/);
  });

  it("writes Codex sandbox config with approvals disabled for headless execution", () => {
    const launcherSource = readFileSync(
      new URL("../../packages/core/src/bootstrap/launcher.ts", import.meta.url),
      "utf8",
    );

    assert.match(launcherSource, /approval_policy = "never"/);
  });

  it("serializes submitted paths into the S3_PATHS env payload", () => {
    assert.equal(
      pathsToEnvValue([
        {
          name: "cloud",
          s3CodeKey: "code-cloud.tar.gz",
          repoOwner: "AgentWorkforce",
          repoName: "cloud",
        },
        {
          name: "relay",
          s3CodeKey: "code-relay.tar.gz",
        },
      ]),
      JSON.stringify([
        {
          name: "cloud",
          s3CodeKey: "code-cloud.tar.gz",
          repoOwner: "AgentWorkforce",
          repoName: "cloud",
        },
        {
          name: "relay",
          s3CodeKey: "code-relay.tar.gz",
        },
      ]),
    );
  });

  it("keeps legacy launches from emitting a non-empty S3_PATHS payload", () => {
    assert.equal(pathsToEnvValue(undefined), "");
    assert.equal(pathsToEnvValue([]), "");
  });

  // Phase B P1: workflow file lives in paths[1], not paths[0]. The pre-fix
  // launcher always built WORKFLOW_FILE from paths[0], so a multi-repo run
  // whose workflow file lived in any non-first repo pointed at a missing
  // file under /home/daytona/workspace/<paths[0].name>/<workflowPath>.
  it("WORKFLOW_FILE multi-path: resolves to the path whose name prefixes workflowPath", () => {
    const paths = [
      { name: "cloud", s3CodeKey: "cloud.tar.gz" },
      { name: "relay", s3CodeKey: "relay.tar.gz" },
    ];
    const resolved = resolveMultiPathWorkflowFile(
      "relay/workflows/runner.ts",
      paths,
    );
    assert.equal(resolved, "/home/daytona/workspace/relay/workflows/runner.ts");
    // Sanity: prefix must be the matched mount, not the first mount.
    assert.ok(
      !resolved.startsWith("/home/daytona/workspace/cloud/"),
      "WORKFLOW_FILE must not be prefixed by paths[0].name when paths[1].name matches",
    );
  });

  it("WORKFLOW_FILE multi-path: falls back to paths[0] with a warning when no path matches", () => {
    const paths = [
      { name: "cloud", s3CodeKey: "cloud.tar.gz" },
      { name: "relay", s3CodeKey: "relay.tar.gz" },
    ];
    const resolved = resolveMultiPathWorkflowFile(
      "unknown/workflows/runner.ts",
      paths,
    );
    // Defensive fallback prefixes paths[0]; warning is observable via console
    // but we only assert behaviour here, not that the warning was emitted.
    assert.equal(resolved, "/home/daytona/workspace/cloud/unknown/workflows/runner.ts");
  });
});

describe("deriveInteractive", () => {
  it("returns true when no config is provided", () => {
    assert.equal(deriveInteractive(undefined), true);
  });

  it("returns true for empty agents array", () => {
    assert.equal(deriveInteractive(JSON.stringify({ agents: [] })), true);
  });

  it("returns false when all agents have interactive:false", () => {
    const config = JSON.stringify({
      agents: [
        { name: "a", interactive: false },
        { name: "b", interactive: false },
      ],
    });
    assert.equal(deriveInteractive(config), false);
  });

  it("returns true when any agent is interactive", () => {
    const config = JSON.stringify({
      agents: [
        { name: "a", interactive: true },
        { name: "b", interactive: false },
      ],
    });
    assert.equal(deriveInteractive(config), true);
  });

  it("returns false when agent has explicit interactive:false even with role:lead", () => {
    // Explicit interactive flag beats role — per resolution order in agentIsInteractive
    const config = JSON.stringify({
      agents: [{ name: "a", interactive: false, role: "lead" }],
    });
    assert.equal(deriveInteractive(config), false);
  });

  it("returns true on malformed JSON (graceful fallback)", () => {
    assert.equal(deriveInteractive("{not valid json"), true);
  });
});

describe("buildMsdReviewInputJson", () => {
  it("forwards plain records as-is and reports the execution mode", () => {
    const json = buildMsdReviewInputJson(
      "shared-sandbox",
      { source: "msd-review", ttlMinutes: 60 },
      { repository: { fullName: "my-org/my-repo" } },
    );
    assert.deepEqual(JSON.parse(json), {
      runtime: {
        executionMode: "shared-sandbox",
        config: { source: "msd-review", ttlMinutes: 60 },
      },
      inputs: { repository: { fullName: "my-org/my-repo" } },
    });
  });

  it("normalizes undefined and null inputs to null", () => {
    const json = buildMsdReviewInputJson("shared-sandbox", undefined, undefined);
    assert.deepEqual(JSON.parse(json), {
      runtime: { executionMode: "shared-sandbox", config: null },
      inputs: null,
    });

    const jsonWithNull = buildMsdReviewInputJson("shared-sandbox", null, null);
    assert.deepEqual(JSON.parse(jsonWithNull), {
      runtime: { executionMode: "shared-sandbox", config: null },
      inputs: null,
    });
  });

  it("coerces non-object values (primitives, arrays) to {} so the contract shape is preserved", () => {
    // A primitive — would otherwise reach the sandbox as `runtime.config: 42`.
    const fromPrimitive = buildMsdReviewInputJson("shared-sandbox", 42, "oops");
    assert.deepEqual(JSON.parse(fromPrimitive), {
      runtime: { executionMode: "shared-sandbox", config: {} },
      inputs: {},
    });

    // An array — JSON-valid but not a record. Same coercion applies.
    const fromArray = buildMsdReviewInputJson(
      "shared-sandbox",
      [1, 2, 3],
      ["a", "b"],
    );
    assert.deepEqual(JSON.parse(fromArray), {
      runtime: { executionMode: "shared-sandbox", config: {} },
      inputs: {},
    });
  });

  it("preserves the per-step-sandbox executionMode when used in non-shared paths", () => {
    // Defensive: callers should not invoke this for per-step-sandbox runs,
    // but if they do, the function still produces a stable shape.
    const json = buildMsdReviewInputJson("per-step-sandbox", null, null);
    assert.deepEqual(JSON.parse(json), {
      runtime: { executionMode: "per-step-sandbox", config: null },
      inputs: null,
    });
  });
});
