import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { SandboxedStepExecutor } from "../src/executor/executor.js";
import type { CredentialBundle } from "../src/auth/credentials.js";
import type {
  ExecOptions,
  LaunchOptions,
  RuntimeCapabilities,
  RuntimeHandle,
  WorkflowRuntime,
} from "../src/runtime/types.js";

const capabilities: RuntimeCapabilities = {
  pty: false,
  snapshots: true,
  isolation: "strong",
  persistentHandle: true,
  streamingLogs: false,
};

class RecordingRuntime implements WorkflowRuntime {
  readonly id = "recording";
  readonly capabilities = capabilities;
  readonly calls: Array<{
    handle: RuntimeHandle;
    command: string;
    options: ExecOptions;
  }> = [];
  readonly uploads: Array<{
    handle: RuntimeHandle;
    source: string | Buffer;
    destination: string;
  }> = [];
  readonly downloads: Array<{
    handle: RuntimeHandle;
    source: string;
  }> = [];
  readonly launches: LaunchOptions[] = [];
  destroyCalls = 0;
  destroyFailuresRemaining = 0;
  execHandler?: (
    handle: RuntimeHandle,
    command: string,
    options: ExecOptions,
  ) => { output: string; exitCode: number } | Promise<{ output: string; exitCode: number }>;
  downloadHandler?: (
    handle: RuntimeHandle,
    source: string,
  ) => Buffer | void | Promise<Buffer | void>;

  async launch(options: LaunchOptions = {}): Promise<RuntimeHandle> {
    this.launches.push(options);
    return {
      id: `fresh-sandbox-${this.launches.length}`,
      homeDir: "/home/daytona",
      workdir: options.workdir,
    };
  }

  async exec(
    handle: RuntimeHandle,
    command: string,
    options: ExecOptions = {},
  ): Promise<{ output: string; exitCode: number }> {
    this.calls.push({ handle, command, options });
    if (command.includes("mcp-args --register")) {
      return { output: '{"args":[],"sideEffectFiles":[]}\n', exitCode: 0 };
    }
    if (this.execHandler) {
      return this.execHandler(handle, command, options);
    }
    if (command.includes("relayfile-initial-sync-exit:")) {
      // Detached initial-sync status probe — report success immediately.
      return { output: "relayfile-initial-sync-exit:0\n", exitCode: 0 };
    }
    const output = command.includes("nohup relayfile-mount") ? "12345\n" : "ok\n";
    return { output, exitCode: 0 };
  }

  async uploadFile(handle: RuntimeHandle, source: string | Buffer, destination: string): Promise<void> {
    this.uploads.push({ handle, source, destination });
  }

  async downloadFile(handle: RuntimeHandle, source: string): Promise<Buffer | void> {
    this.downloads.push({ handle, source });
    if (this.downloadHandler) {
      return this.downloadHandler(handle, source);
    }
    return Buffer.from("");
  }

  async getHomeDir(handle: RuntimeHandle): Promise<string> {
    return handle.homeDir ?? "/home/daytona";
  }

  async destroy(): Promise<void> {
    this.destroyCalls += 1;
    if (this.destroyFailuresRemaining > 0) {
      this.destroyFailuresRemaining -= 1;
      throw new Error("transient destroy failure");
    }
  }
}

const credentials: CredentialBundle = {
  s3Credentials: {
    backend: "cloud-api",
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: "",
    bucket: "",
    prefix: "",
    cloudApiUrl: "https://cloud-api.example",
    cloudApiAccessToken: "cloud-api-token",
  },
  cliCredentials: "",
  workspaceId: "rw_cred0000",
  relayApiKey: "relay-api-key",
  relayBaseUrl: "https://relaycast.example",
  runId: "run-1",
  userId: "user-1",
};

function createExecutor(
  runtime: RecordingRuntime,
  orchestratorRuntimeHandle?: RuntimeHandle,
  credentialOverrides: Partial<CredentialBundle> = {},
): SandboxedStepExecutor {
  return new SandboxedStepExecutor({
    runtime,
    credentials: { ...credentials, ...credentialOverrides },
    s3: {
      putObject: async () => {},
    } as never,
    relayfileUrl: "https://relayfile.example/",
    relayfileToken: "workspace-relayfile-token",
    relayfileWorkspaceId: "rw_abc12345",
    codeMountPath: "/project",
    orchestratorRuntimeHandle,
  });
}

function assertStepEnv(env: Record<string, string> | undefined): void {
  assert.ok(env, "deterministic command should receive an env object");
  assert.equal(env.RELAYFILE_URL, "https://relayfile.example");
  assert.equal(env.RELAYFILE_TOKEN, "workspace-relayfile-token");
  assert.equal(env.RELAY_WORKSPACE_ID, "rw_abc12345");
  assert.equal(env.RELAYFILE_WORKSPACE, "rw_abc12345");
  assert.equal(env.RELAYFILE_WORKSPACE_ID, "rw_abc12345");
  assert.equal(env.CLOUD_API_URL, "https://cloud-api.example");
  assert.equal(env.CLOUD_API_ACCESS_TOKEN, "cloud-api-token");
}

test("executeDeterministicStep forwards relayfile and Cloud API env in orchestrator sandbox", async () => {
  const runtime = new RecordingRuntime();
  const executor = createExecutor(runtime, {
    id: "orchestrator-sandbox",
    homeDir: "/home/daytona",
    workdir: "/project",
  });

  await executor.executeDeterministicStep(
    { name: "preflight" },
    "node /tmp/cloud-small-issue-materialize.cjs",
    "/project",
  );

  const deterministicCall = runtime.calls.find(
    (call) => call.command === "node /tmp/cloud-small-issue-materialize.cjs",
  );
  assertStepEnv(deterministicCall?.options.env);
});

test("createEnvironment mounts Cloud API auth at canonical relay SDK path", async () => {
  const runtime = new RecordingRuntime();
  const executor = createExecutor(runtime, undefined, {
    cloudApiRefreshToken: "cloud-refresh-token",
    cloudApiAccessTokenExpiresAt: "2026-06-13T12:00:00.000Z",
  });

  const env = await executor.createEnvironment("lead");

  assert.ok(
    runtime.calls.some((call) =>
      call.command.startsWith("mkdir -p ")
      && call.command.includes("/home/daytona/.agentworkforce/relay")
    ),
    "sandbox should create the canonical relay SDK auth directory",
  );
  const authUpload = runtime.uploads.find((upload) =>
    upload.destination.endsWith("/.agentworkforce/relay/cloud-auth.json")
  );
  assert.ok(authUpload, "sandbox should receive cloud-auth.json at the canonical SDK path");
  assert.equal(
    authUpload.destination,
    "/home/daytona/.agentworkforce/relay/cloud-auth.json",
  );
  assert.deepEqual(JSON.parse(String(authUpload.source)), {
    apiUrl: "https://cloud-api.example",
    accessToken: "cloud-api-token",
    refreshToken: "cloud-refresh-token",
    accessTokenExpiresAt: "2026-06-13T12:00:00.000Z",
  });
  await env.destroy();
});

test("executeDeterministicStep forwards Claude setup-token env to fresh step sandbox", async () => {
  const runtime = new RecordingRuntime();
  const executor = createExecutor(runtime, undefined, {
    cliCredentials: JSON.stringify({
      anthropic: JSON.stringify({
        type: "oauth_token",
        modelProvider: "anthropic",
        token: "sk-ant-oat-step",
      }),
    }),
  });

  await executor.executeDeterministicStep(
    { name: "preflight" },
    "node /tmp/cloud-small-issue-materialize.cjs",
    "/project",
  );

  const deterministicCall = runtime.calls.find(
    (call) => call.command === "node /tmp/cloud-small-issue-materialize.cjs",
  );
  assert.equal(
    deterministicCall?.options.env?.CLAUDE_CODE_OAUTH_TOKEN,
    "sk-ant-oat-step",
  );
});

test("executeDeterministicStep forwards relayfile and Cloud API env in fresh step sandbox", async () => {
  const runtime = new RecordingRuntime();
  const executor = createExecutor(runtime);

  await executor.executeDeterministicStep(
    { name: "preflight" },
    "node /tmp/cloud-small-issue-materialize.cjs",
    "/project",
  );

  const deterministicCall = runtime.calls.find(
    (call) => call.command === "node /tmp/cloud-small-issue-materialize.cjs",
  );
  assertStepEnv(deterministicCall?.options.env);
});

test("fresh step relayfile mount allows slow full-repo initial sync", async () => {
  const runtime = new RecordingRuntime();
  const executor = createExecutor(runtime);

  await executor.executeDeterministicStep({ name: "preflight" }, "true", "/project");

  assert.ok(
    runtime.calls.some((call) =>
      call.command.includes("RELAYFILE_BOOTSTRAP_IDLE_TIMEOUT=300s")
      && call.command.includes("relayfile initial sync made no progress for 300s"),
    ),
    "fresh step initial sync should use the extended 300s no-progress window",
  );
});

test("fresh agent step seeds from orchestrator archive and skips bidirectional relayfile mount", async () => {
  const runtime = new RecordingRuntime();
  runtime.downloadHandler = (handle, source) => {
    if (handle.id === "orchestrator-sandbox" && source.startsWith("/tmp/agent-relay-step-seed-")) {
      return Buffer.from("workspace archive");
    }
    return Buffer.from("");
  };
  const executor = createExecutor(runtime, {
    id: "orchestrator-sandbox",
    homeDir: "/home/daytona",
    workdir: "/project",
  });

  await executor.executeAgentStep(
    { name: "implement", agent: "impl" },
    { name: "impl", cli: "codex", preset: "worker" },
    "Add the README testing section",
    30_000,
  );

  assert.equal(
    runtime.calls.some((call) => call.command.includes("nohup relayfile-mount")),
    false,
    "agent step should not start the bidirectional relayfile mirror after orchestrator seeding",
  );
  assert.ok(
    runtime.calls.some((call) =>
      call.handle.id === "orchestrator-sandbox"
      && call.command.includes("tar")
      && call.command.includes("-czf")
      && call.command.includes("agent-relay-step-seed-implement"),
    ),
    "orchestrator workspace should be archived for the step sandbox",
  );
  const archiveCall = runtime.calls.find((call) =>
    call.handle.id === "orchestrator-sandbox"
    && call.command.includes("tar")
    && call.command.includes("-czf")
    && call.command.includes("agent-relay-step-seed-implement")
  );
  assert.ok(archiveCall, "archive command should be recorded");
  assert.match(archiveCall.command, /--exclude='\.\/\.agent-relay'/);
  assert.match(archiveCall.command, /--exclude='\.\/\.relay'/);
  assert.match(archiveCall.command, /--exclude='\.\/\.skills'/);
  assert.match(archiveCall.command, /--exclude='\.\/\.trajectories'/);
  assert.match(archiveCall.command, /--exclude='\.\/\.relayfile\.acl'/);
  assert.ok(
    runtime.calls.some((call) =>
      call.handle.id === "fresh-sandbox-1"
      && call.command.includes("tar -xzf")
      && call.command.includes("agent-relay-step-seed-implement"),
    ),
    "step sandbox should extract the orchestrator workspace archive",
  );
  assert.ok(
    runtime.uploads.some((upload) =>
      upload.handle.id === "fresh-sandbox-1"
      && upload.destination.includes("agent-relay-step-seed-implement")
      && Buffer.isBuffer(upload.source)
      && upload.source.toString() === "workspace archive",
    ),
    "archive should be uploaded into the step sandbox",
  );
});

test("agent step artifact propagation copies codex diff back for open-pr", async () => {
  const runtime = new RecordingRuntime();
  const changedPath = "cloud/packages/daytona-runner/README.md";
  runtime.downloadHandler = (handle, source) => {
    if (handle.id === "orchestrator-sandbox" && source.startsWith("/tmp/agent-relay-step-seed-")) {
      return Buffer.from("workspace archive");
    }
    if (handle.id === "fresh-sandbox-1" && source === `/project/${changedPath}`) {
      return Buffer.from("# Daytona Runner\n\n## Testing\n\nRun `npm test`.\n");
    }
    return Buffer.from("");
  };
  runtime.execHandler = (handle, command) => {
    if (command.includes("find .") && command.includes("-printf '%P\\t%s\\t%T@\\n'")) {
      return { output: `${changedPath}\t48\t1\n`, exitCode: 0 };
    }
    const decodedGitChangedScript = decodeGitChangedScript(command);
    if (decodedGitChangedScript?.includes("git -C \"$top\" diff --name-only")) {
      return {
        output: `__AGENT_RELAY_GIT_REPO__\tcloud/\n${changedPath}\n`,
        exitCode: 0,
      };
    }
    if (command.includes("nohup relayfile-mount")) {
      return { output: "12345\n", exitCode: 0 };
    }
    if (command.includes("relayfile-initial-sync-exit:")) {
      return { output: "relayfile-initial-sync-exit:0\n", exitCode: 0 };
    }
    return { output: "ok\n", exitCode: 0 };
  };
  const executor = createExecutor(runtime, {
    id: "orchestrator-sandbox",
    homeDir: "/home/daytona",
    workdir: "/project",
  });

  await executor.executeAgentStep(
    { name: "implement", agent: "impl" },
    { name: "impl", cli: "codex", preset: "worker" },
    "Add the README testing section",
    30_000,
  );

  const propagated = runtime.uploads.find((upload) =>
    upload.handle.id === "orchestrator-sandbox"
    && upload.destination === `/project/${changedPath}`
  );
  assert.ok(propagated, "changed README should be copied back to the orchestrator workspace");
  assert.ok(Buffer.isBuffer(propagated.source));
  assert.match(propagated.source.toString(), /## Testing/);
});

function decodeGitChangedScript(command: string): string | null {
  const match = command.match(/printf %s '([^']+)' \| base64 -d/);
  if (!match) return null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  return decoded.includes("__AGENT_RELAY_GIT_REPO__") ? decoded : null;
}

test("fresh deterministic step skips relayfile mount when workspace is already populated", async () => {
  const runtime = new RecordingRuntime();
  runtime.execHandler = (_handle, command) => {
    if (command.includes("find '/project' -mindepth 1 -maxdepth 1")) {
      return { output: "populated", exitCode: 0 };
    }
    if (command.includes("nohup relayfile-mount")) {
      return { output: "12345\n", exitCode: 0 };
    }
    if (command.includes("relayfile-initial-sync-exit:")) {
      return { output: "relayfile-initial-sync-exit:0\n", exitCode: 0 };
    }
    return { output: "ok\n", exitCode: 0 };
  };
  const executor = createExecutor(runtime);

  await executor.executeDeterministicStep({ name: "open-pr" }, "node create-pr.cjs", "/project/cloud");

  assert.equal(
    runtime.calls.some((call) => call.command.includes("nohup relayfile-mount")),
    false,
    "post-materialize deterministic steps should not start the full bidirectional relayfile mirror",
  );
  assert.ok(
    runtime.calls.some((call) => call.command === "node create-pr.cjs"),
    "deterministic command should still run against the populated workspace",
  );
});

test("bootstrap relayfile seed allows slow full-repo initial flush", () => {
  const source = readFileSync(
    new URL("../src/bootstrap/templates/bootstrap-inner.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /const RELAYFILE_MOUNT_ONCE_TIMEOUT_MS = 300_000;/);
  assert.match(source, /timeout: RELAYFILE_MOUNT_ONCE_TIMEOUT_MS/);
});

test("fresh step sandboxes use unique physical names while preserving logical labels", async () => {
  const runtime = new RecordingRuntime();
  const executor = createExecutor(runtime);

  await executor.executeDeterministicStep({ name: "implement" }, "true", "/project");
  await executor.executeDeterministicStep({ name: "implement" }, "true", "/project");

  assert.equal(runtime.launches.length, 2);
  assert.equal(runtime.launches[0]?.label, "implement");
  assert.equal(runtime.launches[1]?.label, "implement");
  assert.deepEqual(runtime.launches[0]?.labels, { step: "implement" });
  assert.deepEqual(runtime.launches[1]?.labels, { step: "implement" });
  assert.match(runtime.launches[0]?.name ?? "", /^implement-run-1-/);
  assert.match(runtime.launches[1]?.name ?? "", /^implement-run-1-/);
  assert.notEqual(runtime.launches[0]?.name, runtime.launches[1]?.name);
});

test("fresh step sandbox teardown retries transient destroy failures", async () => {
  const runtime = new RecordingRuntime();
  runtime.destroyFailuresRemaining = 1;
  const executor = createExecutor(runtime);

  await executor.executeDeterministicStep({ name: "implement" }, "true", "/project");

  assert.equal(runtime.destroyCalls, 2);
});
