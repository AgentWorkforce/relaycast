import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DaytonaStepExecutor } from "../../packages/core/src/executor/executor.js";
import { buildAgentCommand } from "../../packages/core/src/executor/presets.js";
import { LogStreamer } from "../../packages/core/src/storage/log-streamer.js";
import type { RuntimeHandle, WorkflowRuntime } from "../../packages/core/src/runtime/types.js";

describe("DaytonaStepExecutor.executeAgentStep", () => {
  it("wires claude relaycast MCP config into the spawned command", async () => {
    const mcpConfigJson = JSON.stringify({ mcpServers: { relaycast: { command: "npx" } } });
    const { executor, captured, runtimeCommands } = createCommandCaptureExecutor({
      mcpArgsResult: {
        args: ["--mcp-config", mcpConfigJson],
        sideEffectFiles: [],
        agentToken: "at_live_testtoken",
      },
    });

    await executor.executeAgentStep(
      { name: "claude-step", agent: "worker-a" } as any,
      { name: "worker-a", cli: "claude", preset: "lead", interactive: true } as any,
      "do this work",
    );

    assert.ok(
      runtimeCommands.some((command) =>
        /mcp-args --register --cli 'claude' --agent-name 'worker-a'/.test(command)
      ),
      runtimeCommands.join("\n"),
    );
    // The broker must receive the relaycast base URL so `--register` targets
    // the same backend the API key was minted against. Before this fix the
    // executor passed only env and the broker errored with
    // "--register requires a base URL". Guard against regression: assert
    // both the CLI flag and the env var are present in the invocation.
    const mcpArgsCommand = runtimeCommands.find((c) => c.includes("mcp-args --register"));
    assert.ok(mcpArgsCommand, "expected to find mcp-args --register invocation");
    assert.match(mcpArgsCommand, /--base-url 'https:\/\/relay\.test'/);
    assert.equal(
      extractSingleQuotedArgAfter(captured.command!, "'--mcp-config' "),
      mcpConfigJson,
    );
  });

  it("wires codex relaycast MCP config into the spawned command", async () => {
    const { executor, captured } = createCommandCaptureExecutor({
      mcpArgsResult: {
        args: [
          "--config",
          "check_for_update_on_startup=false",
          "--config",
          'mcp_servers.relaycast.command="npx"',
          "--config",
          'mcp_servers.relaycast.args=["-y", "@relaycast/mcp"]',
          "--config",
          'mcp_servers.relaycast.env.RELAY_AGENT_TOKEN="at_live_testtoken"',
        ],
        sideEffectFiles: [],
        agentToken: "at_live_testtoken",
      },
    });

    await executor.executeAgentStep(
      { name: "codex-step", agent: "worker-a" } as any,
      { name: "worker-a", cli: "codex", preset: "lead", interactive: true } as any,
      "do this work",
    );

    assert.ok(captured.command?.includes("'--config'"), captured.command);
    assert.equal(countOccurrences(captured.command!, "check_for_update_on_startup=false"), 1);
    assert.equal(countOccurrences(captured.command!, 'mcp_servers.relaycast.command="npx"'), 1);
    assert.equal(countOccurrences(captured.command!, 'mcp_servers.relaycast.args=["-y", "@relaycast/mcp"]'), 1);
    assert.equal(countOccurrences(captured.command!, 'mcp_servers.relaycast.env.RELAY_AGENT_TOKEN="at_live_testtoken"'), 1);
  });

  it("keeps opencode relaycast MCP wiring unchanged", async () => {
    const { executor, captured } = createCommandCaptureExecutor({
      mcpArgsResult: {
        args: ["--agent", "relaycast"],
        sideEffectFiles: ["/home/daytona/project/opencode.json"],
        agentToken: "at_live_testtoken",
      },
    });
    const task = "do this work";

    await executor.executeAgentStep(
      { name: "opencode-step", agent: "worker-a" } as any,
      { name: "worker-a", cli: "opencode", preset: "lead", interactive: true } as any,
      task,
    );

    const expected = (await buildAgentCommand("opencode" as any, "lead", task, "worker-a"))
      .command + " '--agent' 'relaycast'";
    assert.equal(captured.command, expected);
    assert.ok(captured.command?.includes("'--agent' 'relaycast'"), captured.command);
  });

  it("does not use relayfile tokens for relaycast MCP wiring", async (t) => {
    const mcpConfigJson = JSON.stringify({
      mcpServers: {
        relaycast: {
          env: { RELAY_AGENT_TOKEN: "at_live_testtoken" },
        },
      },
    });
    const { executor, captured } = createCommandCaptureExecutor({
      mcpArgsResult: {
        args: ["--mcp-config", mcpConfigJson],
        sideEffectFiles: [],
        agentToken: "at_live_testtoken",
      },
    });
    const original = (executor as any).resolveRelayfileTokenForAgent.bind(executor);
    const spy = t.mock.method(
      executor as any,
      "resolveRelayfileTokenForAgent",
      (agentName: string) => original(agentName),
    );

    await executor.executeAgentStep(
      { name: "claude-step", agent: "worker-a" } as any,
      { name: "worker-a", cli: "claude", preset: "lead", interactive: true } as any,
      "do this work",
    );

    assert.ok(spy.mock.callCount() <= 3);
    assert.equal(captured.command?.includes("test-token"), false, captured.command);
    assert.equal(captured.env?.RELAYFILE_TOKEN, "test-token");
  });

  it("fails the step when mcp-args fails", async () => {
    const { executor } = createCommandCaptureExecutor({
      mcpArgsResult: { output: "relay unreachable", exitCode: 2 },
    });

    await assert.rejects(
      executor.executeAgentStep(
        { name: "claude-step", agent: "worker-a" } as any,
        { name: "worker-a", cli: "claude", preset: "lead", interactive: true } as any,
        "do this work",
      ),
      /mcp-args --register failed.*relay unreachable/s,
    );
  });

  it("fails the step when RELAY_API_KEY is missing (no silent degrade to no-MCP)", async () => {
    const { executor } = createCommandCaptureExecutor({
      credentialsOverride: { relayApiKey: "" },
    });

    await assert.rejects(
      executor.executeAgentStep(
        { name: "claude-step", agent: "worker-a" } as any,
        { name: "worker-a", cli: "claude", preset: "lead", interactive: true } as any,
        "do this work",
      ),
      /RELAY_API_KEY is empty/,
    );
  });

  it("disables broker telemetry to keep the JSON output clean", async () => {
    const { executor, runtimeCommandEnvs } = createCommandCaptureExecutor({
      mcpArgsResult: {
        args: ["--mcp-config", "{}"],
        sideEffectFiles: [],
        agentToken: "at_live_t",
      },
    });

    await executor.executeAgentStep(
      { name: "claude-step", agent: "worker-a" } as any,
      { name: "worker-a", cli: "claude", preset: "lead", interactive: true } as any,
      "do this work",
    );

    // The broker's first-run banner goes to stderr and gets merged with
    // stdout by Daytona's executeCommand. Setting the env var short-
    // circuits TelemetryClient::new before the banner is printed.
    const mcpArgsCall = runtimeCommandEnvs.find(
      (entry) => entry.command.includes("mcp-args --register"),
    );
    assert.ok(mcpArgsCall, "expected to find mcp-args --register invocation");
    assert.equal(mcpArgsCall.env?.AGENT_RELAY_TELEMETRY_DISABLED, "1");
  });

  it("parses the JSON portion of mcp-args output even when stderr noise is merged in", async () => {
    const mcpConfigJson = JSON.stringify({ mcpServers: { relaycast: {} } });
    const noisyOutput =
      "Agent Relay collects anonymous usage data to improve the product.\n" +
      "Run `agent-relay telemetry disable` to opt out.\n" +
      JSON.stringify({
        args: ["--mcp-config", mcpConfigJson],
        sideEffectFiles: [],
        agentToken: "at_live_merged_stderr_case",
      });
    const { executor, captured } = createCommandCaptureExecutor({
      mcpArgsResult: { output: noisyOutput, exitCode: 0 },
    });

    await executor.executeAgentStep(
      { name: "claude-step", agent: "worker-a" } as any,
      { name: "worker-a", cli: "claude", preset: "lead", interactive: true } as any,
      "do this work",
    );

    // The parsed args must still reach the final agent command despite
    // the leading banner. Regression guard for the "Unexpected identifier
    // 'Agent'" failure on production.
    assert.equal(
      extractSingleQuotedArgAfter(captured.command!, "'--mcp-config' "),
      mcpConfigJson,
    );
  });

  it("fails the step with a clear error when mcp-args output contains no JSON at all", async () => {
    const { executor } = createCommandCaptureExecutor({
      mcpArgsResult: { output: "some noise without json", exitCode: 0 },
    });

    await assert.rejects(
      executor.executeAgentStep(
        { name: "claude-step", agent: "worker-a" } as any,
        { name: "worker-a", cli: "claude", preset: "lead", interactive: true } as any,
        "do this work",
      ),
      /returned no JSON object/,
    );
  });

  it("propagates files created during a successful agent step to the orchestrator cwd", async () => {
    const { executor, downloaded, uploadedToOrchestrator, putObjectCalls } =
      createArtifactPropagationExecutor({
        findOutputs: [
          "already-there.txt\t8\t1\n",
          "already-there.txt\t8\t1\ncreated-by-agent.txt\t13\t2\n",
        ],
        downloads: {
          "/project/created-by-agent.txt": Buffer.from("created-body\n"),
        },
      });

    (executor as any).runCommand = async () => ({
      output: "DONE",
      exitCode: 0,
    });

    await executor.executeAgentStep(
      { name: "write-created-file", agent: "writer" } as any,
      { name: "writer", cli: "claude", preset: "worker", interactive: true } as any,
      "write created-by-agent.txt",
    );

    assert.deepEqual(downloaded, ["/project/created-by-agent.txt"]);
    assert.equal(uploadedToOrchestrator.length, 1);
    assert.equal(uploadedToOrchestrator[0].destination, "/project/created-by-agent.txt");
    assert.equal(uploadedToOrchestrator[0].body.toString("utf8"), "created-body\n");

    const metadata = readMetadata(putObjectCalls, "sandbox-1/metadata.json");
    assert.deepEqual(metadata.artifactPropagation.copied, ["created-by-agent.txt"]);
    assert.deepEqual(metadata.artifactPropagation.skipped, []);
    assert.equal(metadata.artifactPropagation.propagated, true);
  });

  it("fails loudly when a non-empty baseline becomes an empty final listing", async () => {
    const { executor } =
      createArtifactPropagationExecutor({
        findOutputs: [
          "already-there.txt\t8\t1\n",
          "",
        ],
      });

    (executor as any).runCommand = async () => ({
      output: "DONE",
      exitCode: 0,
    });

    await assert.rejects(
      executor.executeAgentStep(
        { name: "degraded-mount-step", agent: "writer" } as any,
        { name: "writer", cli: "claude", preset: "worker", interactive: true } as any,
        "write a file while the mount is degraded",
      ),
      /baseline listed 1 files but final listing was empty/,
    );
  });

  it("uses git changed files when mount metadata is unchanged", async () => {
    const { executor, downloaded, uploadedToOrchestrator, putObjectCalls } =
      createArtifactPropagationExecutor({
        findOutputs: [
          "cloud/packages/web/lib/app-path.ts\t20\t1\n",
          "cloud/packages/web/lib/app-path.ts\t20\t1\n",
        ],
        gitChangedOutputs: [
          "__AGENT_RELAY_GIT_REPO__\tcloud/\ncloud/packages/web/lib/app-path.ts\n",
        ],
        downloads: {
          "/project/cloud/packages/web/lib/app-path.ts": Buffer.from("updated app path\n"),
        },
      });

    (executor as any).runCommand = async () => ({
      output: "DONE",
      exitCode: 0,
    });

    await executor.executeAgentStep(
      { name: "edit-existing-file", agent: "writer" } as any,
      { name: "writer", cli: "claude", preset: "worker", interactive: true } as any,
      "edit cloud/packages/web/lib/app-path.ts",
    );

    assert.deepEqual(downloaded, ["/project/cloud/packages/web/lib/app-path.ts"]);
    assert.deepEqual(
      uploadedToOrchestrator.map((upload) => [
        upload.destination,
        upload.body.toString("utf8"),
      ]),
      [["/project/cloud/packages/web/lib/app-path.ts", "updated app path\n"]],
    );

    const metadata = readMetadata(putObjectCalls, "sandbox-1/metadata.json");
    assert.deepEqual(metadata.artifactPropagation.copied, ["cloud/packages/web/lib/app-path.ts"]);
  });

  it("transports the git changed-files shell script as single-line base64", async () => {
    const { executor, downloaded, uploadedToOrchestrator, runtimeCommands } =
      createArtifactPropagationExecutor({
        findOutputs: [
          "cloud/packages/daytona-runner/README.md\t20\t1\n",
          "cloud/packages/daytona-runner/README.md\t30\t1\n",
        ],
        gitChangedOutputs: [
          "__AGENT_RELAY_GIT_REPO__\tcloud/\ncloud/packages/daytona-runner/README.md\n",
        ],
        downloads: {
          "/project/cloud/packages/daytona-runner/README.md": Buffer.from("updated readme\n"),
        },
      });

    (executor as any).runCommand = async () => ({
      output: "DONE",
      exitCode: 0,
    });

    await executor.executeAgentStep(
      { name: "implement", agent: "writer" } as any,
      { name: "writer", cli: "claude", preset: "worker", interactive: true } as any,
      "edit cloud/packages/daytona-runner/README.md",
    );

    const gitChangedCommand = runtimeCommands.find((command) => decodeGitChangedScript(command));
    assert.ok(gitChangedCommand, "expected git changed-files command to run");
    assert.doesNotMatch(gitChangedCommand, /\n/);
    assert.doesNotMatch(gitChangedCommand, /emit_repo\(\)/);
    const decodedScript = decodeGitChangedScript(gitChangedCommand);
    assert.ok(decodedScript, "expected encoded git changed-files script");
    assert.doesNotMatch(decodedScript, /emit_repo\(\) \{;/);
    assert.match(decodedScript, /emit_repo\(\) \{\n\s+repo="\$1";/);
    assert.match(decodedScript, /printf "__AGENT_RELAY_GIT_REPO__\\t%s\\n" "\$prefix";/);
    assert.match(decodedScript, /emit_repo \./);
    assert.match(decodedScript, /find \. .* -o -name \.git -print \| while IFS= read -r git_marker; do/);
    const flattenedForTransport = gitChangedCommand.replace(/\n/g, ";");
    const bashCheck = spawnSync("bash", ["-n", "-c", flattenedForTransport], {
      encoding: "utf8",
    });
    assert.equal(bashCheck.status, 0, bashCheck.stderr);
    const zshCheck = spawnSync("zsh", ["-n", "-c", flattenedForTransport], {
      encoding: "utf8",
    });
    if (zshCheck.error && (zshCheck.error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw zshCheck.error;
    }
    if (!zshCheck.error) {
      assert.equal(zshCheck.status, 0, zshCheck.stderr);
    }
    assert.deepEqual(downloaded, ["/project/cloud/packages/daytona-runner/README.md"]);
    assert.ok(
      uploadedToOrchestrator.some(
        (upload) =>
          upload.destination === "/project/cloud/packages/daytona-runner/README.md" &&
          upload.body.toString("utf8") === "updated readme\n",
      ),
      "expected propagated README edit to reach the orchestrator",
    );
  });

  it("mirrors implement artifacts into the open-pr fallback path", async () => {
    const { executor, uploadedToOrchestrator, putObjectCalls } =
      createArtifactPropagationExecutor({
        findOutputs: [
          "cloud/packages/web/lib/app-path.ts\t12\t1\n",
          "cloud/packages/web/lib/app-path.ts\t20\t1\n",
        ],
        gitChangedOutputs: [
          "__AGENT_RELAY_GIT_REPO__\tcloud/\ncloud/packages/web/lib/app-path.ts\n",
        ],
        downloads: {
          "/project/cloud/packages/web/lib/app-path.ts": Buffer.from("updated app path\n"),
        },
      });

    (executor as any).runCommand = async () => ({
      output: "DONE",
      exitCode: 0,
    });

    await executor.executeAgentStep(
      { name: "implement", agent: "writer" } as any,
      { name: "writer", cli: "claude", preset: "worker", interactive: true } as any,
      "edit cloud/packages/web/lib/app-path.ts",
    );

    assert.deepEqual(
      uploadedToOrchestrator.map((upload) => [
        upload.destination,
        upload.body.toString("utf8"),
      ]),
      [
        ["/project/cloud/packages/web/lib/app-path.ts", "updated app path\n"],
        ["/project/.agent-relay/step-artifacts/implement/cloud/packages/web/lib/app-path.ts", "updated app path\n"],
      ],
    );

    const metadata = readMetadata(putObjectCalls, "sandbox-1/metadata.json");
    assert.deepEqual(metadata.artifactPropagation.copied, ["cloud/packages/web/lib/app-path.ts"]);
  });

  it("records skipped files but still uploads siblings when downloadFile throws", async () => {
    const { executor, downloaded, uploadedToOrchestrator, putObjectCalls } =
      createArtifactPropagationExecutor({
        findOutputs: [
          "",
          "boom.txt\t5\t1\nok.txt\t6\t2\n",
        ],
        downloads: {
          "/project/ok.txt": Buffer.from("ok-body\n"),
        },
        downloadErrors: {
          "/project/boom.txt": new Error("simulated copy failure"),
        },
      });

    (executor as any).runCommand = async () => ({
      output: "DONE",
      exitCode: 0,
    });

    await executor.executeAgentStep(
      { name: "partial-failure-step", agent: "writer" } as any,
      { name: "writer", cli: "claude", preset: "worker", interactive: true } as any,
      "write two files, one download fails",
    );

    assert.ok(downloaded.includes("/project/boom.txt"));
    assert.ok(downloaded.includes("/project/ok.txt"));
    assert.deepEqual(
      uploadedToOrchestrator.map((upload) => [
        upload.destination,
        upload.body.toString("utf8"),
      ]),
      [["/project/ok.txt", "ok-body\n"]],
    );

    const metadata = readMetadata(putObjectCalls, "sandbox-1/metadata.json");
    assert.deepEqual(metadata.artifactPropagation.copied, ["ok.txt"]);
    assert.equal(metadata.artifactPropagation.skipped.length, 1);
    assert.equal(metadata.artifactPropagation.skipped[0].path, "boom.txt");
    assert.equal(metadata.artifactPropagation.skipped[0].reason, "copy-failed");
    assert.match(
      metadata.artifactPropagation.skipped[0].detail,
      /simulated copy failure/,
    );
    assert.equal(metadata.artifactPropagation.propagated, true);
  });

  it("overwrites an existing orchestrator file when an agent edits it", async () => {
    const { executor, uploadedToOrchestrator, putObjectCalls } =
      createArtifactPropagationExecutor({
        findOutputs: [
          "cloud/packages/web/lib/app-path.ts\t12\t1\n",
          "cloud/packages/web/lib/app-path.ts\t20\t2\n",
        ],
        existingOrchestratorPaths: ["/project/cloud/packages/web/lib/app-path.ts"],
        downloads: {
          "/project/cloud/packages/web/lib/app-path.ts": Buffer.from("updated app path\n"),
        },
      });

    (executor as any).runCommand = async () => ({
      output: "DONE",
      exitCode: 0,
    });

    await executor.executeAgentStep(
      { name: "edit-existing-file", agent: "writer" } as any,
      { name: "writer", cli: "claude", preset: "worker", interactive: true } as any,
      "edit cloud/packages/web/lib/app-path.ts",
    );

    assert.deepEqual(
      uploadedToOrchestrator.map((upload) => [
        upload.destination,
        upload.body.toString("utf8"),
      ]),
      [["/project/cloud/packages/web/lib/app-path.ts", "updated app path\n"]],
    );

    const metadata = readMetadata(putObjectCalls, "sandbox-1/metadata.json");
    assert.deepEqual(metadata.artifactPropagation.copied, ["cloud/packages/web/lib/app-path.ts"]);
    assert.deepEqual(metadata.artifactPropagation.warnings, []);
  });

  it("does not propagate relayfile/runtime bookkeeping paths as agent artifacts", async () => {
    const { executor, downloaded, uploadedToOrchestrator, putObjectCalls } =
      createArtifactPropagationExecutor({
        findOutputs: [
          "",
          [
            ".relay/state.json\t2\t1",
            ".relayfile.acl\t20\t1",
            ".skills/activity-summary.md\t8\t1",
            ".trajectories/active/run.json\t8\t1",
            "cloud/README.md\t11\t2",
          ].join("\n") + "\n",
        ],
        downloads: {
          "/project/cloud/README.md": Buffer.from("readme edit\n"),
        },
      });

    (executor as any).runCommand = async () => ({
      output: "DONE",
      exitCode: 0,
    });

    await executor.executeAgentStep(
      { name: "runtime-noise", agent: "writer" } as any,
      { name: "writer", cli: "claude", preset: "worker", interactive: true } as any,
      "edit readme",
    );

    assert.deepEqual(downloaded, ["/project/cloud/README.md"]);
    assert.deepEqual(
      uploadedToOrchestrator.map((upload) => upload.destination),
      ["/project/cloud/README.md"],
    );

    const metadata = readMetadata(putObjectCalls, "sandbox-1/metadata.json");
    assert.deepEqual(metadata.artifactPropagation.copied, ["cloud/README.md"]);
    assert.deepEqual(metadata.artifactPropagation.skipped, []);
  });

  it("redirects a later writer of the same path into step artifacts", async () => {
    const { executor, uploadedToOrchestrator, putObjectCalls } =
      createArtifactPropagationExecutor({
        findOutputs: [
          "",
          "shared.txt\t6\t2\n",
          "",
          "shared.txt\t7\t3\n",
        ],
        downloads: {
          "/project/shared.txt": [
            Buffer.from("first\n"),
            Buffer.from("second\n"),
          ],
        },
      });

    (executor as any).runCommand = async () => ({
      output: "DONE",
      exitCode: 0,
    });

    await executor.executeAgentStep(
      { name: "write-one", agent: "writer-one" } as any,
      { name: "writer-one", cli: "claude", preset: "worker", interactive: true } as any,
      "write shared.txt",
    );
    await executor.executeAgentStep(
      { name: "write-two", agent: "writer-two" } as any,
      { name: "writer-two", cli: "claude", preset: "worker", interactive: true } as any,
      "write shared.txt differently",
    );

    assert.deepEqual(
      uploadedToOrchestrator.map((upload) => [
        upload.destination,
        upload.body.toString("utf8"),
      ]),
      [
        ["/project/shared.txt", "first\n"],
        ["/project/.agent-relay/step-artifacts/write-two/shared.txt", "second\n"],
      ],
    );

    const secondMetadata = readMetadata(putObjectCalls, "sandbox-2/metadata.json");
    assert.deepEqual(
      secondMetadata.artifactPropagation.copied,
      [".agent-relay/step-artifacts/write-two/shared.txt"],
    );
    assert.equal(secondMetadata.artifactPropagation.warnings.length, 1);
  });

  it("persists logs when command exits with non-zero code", async () => {
    let finishCalls = 0;
    let abortCalls = 0;
    const originalFinish = (LogStreamer.prototype as any).finish;
    const originalAbort = (LogStreamer.prototype as any).abort;

    (LogStreamer.prototype as any).finish = async function () {
      finishCalls += 1;
    };
    (LogStreamer.prototype as any).abort = async function () {
      abortCalls += 1;
    };

    const daytona = {
      create: async () => ({
        id: "sandbox-id",
        process: {
          executeCommand: async (command: string) => {
            if (command.includes("mcp-args --register")) {
              return {
                result: JSON.stringify({ args: [], sideEffectFiles: [], agentToken: null }),
                exitCode: 0,
              };
            }
            if (command.includes("relayfile-initial-sync-exit:")) {
              return { result: "relayfile-initial-sync-exit:0", exitCode: 0 };
            }
            return { result: "ok", exitCode: 0 };
          },
        },
        fs: {
          uploadFile: async () => undefined,
        },
        getUserHomeDir: async () => "/home/daytona",
      }),
      remove: async () => undefined,
    };

    const executor = new DaytonaStepExecutor({
      daytona: daytona as any,
      credentials: {
        cliCredentials: "cli",
        relayApiKey: "relay",
        relayBaseUrl: "https://relay.test",
        runId: "run-1",
        userId: "user-1",
        workspaceId: "rw_abcd1234",
        daytonaApiKey: "day",
        s3CodeKey: "code.tar.gz",
        s3Credentials: {
          accessKeyId: "akid",
          secretAccessKey: "skey",
          sessionToken: "stoken",
          bucket: "bucket",
          prefix: "prefix",
        },
      },
      s3: {
        putObject: async () => undefined,
      } as any,
      relayfileUrl: "http://localhost:9090",
      relayfileToken: "test-token",
    });

    (executor as any).runCommand = async () => ({
      output: "agent output",
      exitCode: 7,
    });

    await assert.rejects(
      async () =>
        executor.executeAgentStep(
          { name: "agent-step", agent: "agent", cli: "claude" } as any,
          { cli: "claude", preset: "default" } as any,
          "do this work",
        ),
      { message: /exited with code 7/ }
    );

    assert.equal(finishCalls, 1);
    assert.equal(abortCalls, 0);

    (LogStreamer.prototype as any).finish = originalFinish;
    (LogStreamer.prototype as any).abort = originalAbort;
  });

  it("falls back to abort if finish fails in error path", async () => {
    let finishCalls = 0;
    let abortCalls = 0;
    const originalFinish = (LogStreamer.prototype as any).finish;
    const originalAbort = (LogStreamer.prototype as any).abort;

    (LogStreamer.prototype as any).finish = async function () {
      finishCalls += 1;
      throw new Error("finish-failed");
    };
    (LogStreamer.prototype as any).abort = async function () {
      abortCalls += 1;
    };

    const daytona = {
      create: async () => ({
        id: "sandbox-id",
        process: {
          executeCommand: async (command: string) => {
            if (command.includes("mcp-args --register")) {
              return {
                result: JSON.stringify({ args: [], sideEffectFiles: [], agentToken: null }),
                exitCode: 0,
              };
            }
            if (command.includes("relayfile-initial-sync-exit:")) {
              return { result: "relayfile-initial-sync-exit:0", exitCode: 0 };
            }
            return { result: "ok", exitCode: 0 };
          },
        },
        fs: {
          uploadFile: async () => undefined,
        },
        getUserHomeDir: async () => "/home/daytona",
      }),
      delete: async () => undefined,
    };

    const executor = new DaytonaStepExecutor({
      daytona: daytona as any,
      credentials: {
        cliCredentials: "cli",
        relayApiKey: "relay",
        relayBaseUrl: "https://relay.test",
        runId: "run-1",
        userId: "user-1",
        workspaceId: "rw_abcd1234",
        daytonaApiKey: "day",
        s3CodeKey: "code.tar.gz",
        s3Credentials: {
          accessKeyId: "akid",
          secretAccessKey: "skey",
          sessionToken: "stoken",
          bucket: "bucket",
          prefix: "prefix",
        },
      },
      s3: {
        putObject: async () => undefined,
      } as any,
      relayfileUrl: "http://localhost:9090",
      relayfileToken: "test-token",
    });

    (executor as any).runCommand = async () => ({
      output: "agent output",
      exitCode: 7,
    });

    await assert.rejects(
      async () =>
        executor.executeAgentStep(
          { name: "agent-step", agent: "agent", cli: "claude" } as any,
          { cli: "claude", preset: "default" } as any,
          "do this work",
        ),
      { message: /exited with code 7/ }
    );

    assert.equal(finishCalls, 1);
    assert.equal(abortCalls, 1);

    (LogStreamer.prototype as any).finish = originalFinish;
    (LogStreamer.prototype as any).abort = originalAbort;
  });

  it("creates isolated sandboxes when agent steps execute concurrently", async () => {
    const putObjectCalls: Array<{
      key: string;
      body: string;
      contentType: string;
    }> = [];
    const commandEnvs: Array<{
      sandboxId: string;
      env: Record<string, string>;
    }> = [];
    const startedStreamers: LogStreamer[] = [];
    const finishedStreamers: LogStreamer[] = [];
    const mountConfigs: Array<{
      volumeId: string;
      mountPath: string;
    }> = [];
    const createArgs: Array<{ language: string; volumes?: Array<{ id: string; mountPath: string }> }> = [];
    const createResolvers: Array<() => void> = [];
    let createCalls = 0;

    const originalStart = (LogStreamer.prototype as any).start;
    const originalFinish = (LogStreamer.prototype as any).finish;

    (LogStreamer.prototype as any).start = async function () {
      startedStreamers.push(this);
      return originalStart.call(this);
    };
    (LogStreamer.prototype as any).finish = async function () {
      finishedStreamers.push(this);
      return originalFinish.call(this);
    };

    const buildSandbox = (sandboxId: string) => ({
      id: sandboxId,
      process: {
        executeCommand: async (
          command: string,
          _cwd?: string,
          env?: Record<string, string>,
        ) => {
          if (command.includes("mcp-args --register")) {
            return {
              result: JSON.stringify({ args: [], sideEffectFiles: [], agentToken: null }),
              exitCode: 0,
            };
          }
          if (command.includes("relayfile-initial-sync-exit:")) {
            return { result: "relayfile-initial-sync-exit:0", exitCode: 0 };
          }
          if (env) {
            commandEnvs.push({ sandboxId, env });
            return { result: `output from ${sandboxId}`, exitCode: 0 };
          }

          return { result: "", exitCode: 0 };
        },
      },
      fs: {
        uploadFile: async () => undefined,
      },
      getUserHomeDir: async () => "/home/daytona",
    });

    try {
      const daytona = {
        create: async (options: { language: string; volumes?: Array<{ id: string; mountPath: string }> }) => {
          createArgs.push(options);

          const sandboxId = `sandbox-${++createCalls}`;
          return new Promise((resolve) => {
            createResolvers.push(() => resolve(buildSandbox(sandboxId) as any));

            if (createResolvers.length === 2) {
              for (const release of createResolvers.splice(0)) {
                release();
              }
            }
          });
        },
        remove: async () => undefined,
      };

      const executor = new DaytonaStepExecutor({
        daytona: daytona as any,
        credentials: {
          cliCredentials: "cli",
          relayApiKey: "relay",
          relayBaseUrl: "https://relay.test",
          runId: "run-1",
          userId: "user-1",
          workspaceId: "rw_abcd1234",
          daytonaApiKey: "day",
          s3CodeKey: "code.tar.gz",
          s3Credentials: {
            accessKeyId: "akid",
            secretAccessKey: "skey",
            sessionToken: "stoken",
            bucket: "bucket",
            prefix: "prefix",
          },
        },
        s3: {
          putObject: async (key: string, body: Buffer | string, contentType: string) => {
            putObjectCalls.push({
              key,
              body: Buffer.isBuffer(body) ? body.toString("utf8") : body,
              contentType,
            });
          },
        } as any,
        relayfileUrl: "http://localhost:9090",
        relayfileToken: "test-token",
      });

      const [specialistOutput, ownerOutput] = await Promise.all([
        executor.executeAgentStep(
          { name: "specialist-step", agent: "worker" } as any,
          { name: "worker", cli: "claude", interactive: true } as any,
          "write the worker change",
        ),
        executor.executeAgentStep(
          { name: "owner-step", agent: "lead" } as any,
          { name: "lead", cli: "claude", interactive: true } as any,
          "verify the worker change",
        ),
      ]);

      assert.equal(createCalls, 2);
      assert.deepEqual(
        createArgs.map((options) => options.language),
        ["typescript", "typescript"],
      );
      // Volume mounts are now handled by relayfile FUSE mount, not VolumeManager
      assert.deepEqual(
        [specialistOutput, ownerOutput].sort(),
        ["output from sandbox-1", "output from sandbox-2"],
      );

      assert.deepEqual(
        commandEnvs.map(({ sandboxId, env }) => [sandboxId, env.SANDBOX_ID]).sort(),
        [
          ["sandbox-1", "sandbox-1"],
          ["sandbox-2", "sandbox-2"],
        ],
      );

      const metadataCalls = putObjectCalls.filter(({ key }) => key.endsWith("/metadata.json"));
      assert.deepEqual(
        metadataCalls.map(({ key }) => key).sort(),
        ["sandbox-1/metadata.json", "sandbox-2/metadata.json"],
      );

      const metadataByKey = new Map(
        metadataCalls.map(({ key, body }) => [key, JSON.parse(body) as { stepName: string }]),
      );
      assert.equal(metadataByKey.get("sandbox-1/metadata.json")?.stepName, "specialist-step");
      assert.equal(metadataByKey.get("sandbox-2/metadata.json")?.stepName, "owner-step");

      assert.deepEqual(
        putObjectCalls
          .filter(({ key }) => key.endsWith("/agent.log"))
          .map(({ key }) => key)
          .sort(),
        ["sandbox-1/agent.log", "sandbox-2/agent.log"],
      );

      assert.equal(startedStreamers.length, 2);
      assert.equal(new Set(startedStreamers).size, 2);
      assert.equal(finishedStreamers.length, 2);
      assert.equal(new Set(finishedStreamers).size, 2);
      assert.ok(
        startedStreamers.every((streamer) => finishedStreamers.includes(streamer)),
        "each LogStreamer instance should finish independently",
      );
    } finally {
      (LogStreamer.prototype as any).start = originalStart;
      (LogStreamer.prototype as any).finish = originalFinish;
    }
  });
});

function createArtifactPropagationExecutor(options: {
  findOutputs: string[];
  gitChangedOutputs?: string[];
  downloads?: Record<string, Buffer | Buffer[] | null>;
  downloadErrors?: Record<string, Error>;
  existingOrchestratorPaths?: string[];
}): {
  executor: DaytonaStepExecutor;
  downloaded: string[];
  uploadedToOrchestrator: Array<{ destination: string; body: Buffer }>;
  putObjectCalls: Array<{ key: string; body: string; contentType: string }>;
  runtimeCommands: string[];
} {
  const findOutputs = [...options.findOutputs];
  const gitChangedOutputs = [...(options.gitChangedOutputs ?? [])];
  const downloadQueues = new Map<string, Array<Buffer | null>>();
  for (const [path, value] of Object.entries(options.downloads ?? {})) {
    if (value === null) {
      downloadQueues.set(path, [null]);
    } else {
      downloadQueues.set(path, Array.isArray(value) ? [...value] : [value]);
    }
  }
  const downloadErrors = { ...(options.downloadErrors ?? {}) };

  const orchestratorHandle: RuntimeHandle = {
    id: "orchestrator",
    homeDir: "/home/daytona",
    workdir: "/project",
  };
  const existingOrchestratorPaths = new Set(options.existingOrchestratorPaths ?? []);
  const downloaded: string[] = [];
  const uploadedToOrchestrator: Array<{ destination: string; body: Buffer }> = [];
  const putObjectCalls: Array<{ key: string; body: string; contentType: string }> = [];
  const runtimeCommands: string[] = [];
  let launchCount = 0;

  const runtime: WorkflowRuntime = {
    id: "mock-runtime",
    capabilities: {
      pty: false,
      snapshots: false,
      isolation: "strong",
      persistentHandle: true,
      streamingLogs: false,
    },

    async launch(): Promise<RuntimeHandle> {
      launchCount += 1;
      return {
        id: `sandbox-${launchCount}`,
        homeDir: "/home/daytona",
        workdir: "/project",
      };
    },

    async exec(_handle, command): Promise<{ output: string; exitCode: number }> {
      runtimeCommands.push(command);
      if (command.includes("mcp-args --register")) {
        return {
          output: JSON.stringify({ args: [], sideEffectFiles: [], agentToken: null }),
          exitCode: 0,
        };
      }
      if (command.includes("find .") && command.includes("-printf")) {
        return { output: findOutputs.shift() ?? "", exitCode: 0 };
      }
      const decodedGitChangedScript = decodeGitChangedScript(command);
      if (decodedGitChangedScript?.includes("__AGENT_RELAY_GIT_REPO__")) {
        return { output: gitChangedOutputs.shift() ?? "", exitCode: 0 };
      }
      if (command.startsWith("test -e ")) {
        const remotePath = command.match(/^test -e '([^']+)'$/)?.[1] ?? "";
        return {
          output: "",
          exitCode: existingOrchestratorPaths.has(remotePath) ? 0 : 1,
        };
      }
      if (command.includes("nohup relayfile-mount")) {
        return { output: "123", exitCode: 0 };
      }
      // Detached initial-sync status probe — report success so startMount's
      // poll loop completes immediately.
      if (command.includes("relayfile-initial-sync-exit:")) {
        return { output: "relayfile-initial-sync-exit:0", exitCode: 0 };
      }
      if (command.startsWith("which ")) {
        return { output: "/usr/bin/claude", exitCode: 0 };
      }
      return { output: "", exitCode: 0 };
    },

    async uploadFile(handle, source, destination): Promise<void> {
      if (handle.id !== orchestratorHandle.id) {
        return;
      }
      const body = Buffer.isBuffer(source) ? source : Buffer.from(source);
      uploadedToOrchestrator.push({ destination, body });
      existingOrchestratorPaths.add(destination);
    },

    async downloadFile(_handle, source): Promise<Buffer> {
      if (source.startsWith("/tmp/agent-relay-step-seed-")) {
        return Buffer.from("workspace archive");
      }
      downloaded.push(source);
      if (downloadErrors[source]) {
        throw downloadErrors[source];
      }
      const queue = downloadQueues.get(source);
      if (queue && queue.length > 0) {
        const next = queue.shift();
        return next as Buffer;
      }
      return Buffer.from(`contents:${source}`);
    },

    async getHomeDir(handle): Promise<string> {
      return handle.homeDir ?? "/home/daytona";
    },

    async destroy(): Promise<void> {
      return;
    },
  };

  const executor = new DaytonaStepExecutor({
    runtime,
    credentials: {
      cliCredentials: "cli",
      relayApiKey: "relay",
      relayBaseUrl: "https://relay.test",
      runId: "run-1",
      userId: "user-1",
      workspaceId: "rw_abcd1234",
      daytonaApiKey: "day",
      s3CodeKey: "code.tar.gz",
      s3Credentials: {
        accessKeyId: "akid",
        secretAccessKey: "skey",
        sessionToken: "stoken",
        bucket: "bucket",
        prefix: "prefix",
      },
    },
    s3: {
      putObject: async (key: string, body: Buffer | string, contentType: string) => {
        putObjectCalls.push({
          key,
          body: Buffer.isBuffer(body) ? body.toString("utf8") : body,
          contentType,
        });
      },
    } as any,
    relayfileUrl: "http://localhost:9090",
    relayfileToken: "test-token",
    relayfileWorkspaceId: "rw_abcd1234",
    codeMountPath: "/project",
    orchestratorRuntimeHandle: orchestratorHandle,
  });

  return {
    executor,
    downloaded,
    uploadedToOrchestrator,
    putObjectCalls,
    runtimeCommands,
  };
}

function decodeGitChangedScript(command: string): string | null {
  const match = command.match(/printf %s '([^']+)' \| base64 -d/);
  if (!match) return null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  return decoded.includes("__AGENT_RELAY_GIT_REPO__") ? decoded : null;
}

function readMetadata(
  putObjectCalls: Array<{ key: string; body: string }>,
  key: string,
): any {
  const call = putObjectCalls.find((entry) => entry.key === key);
  assert.ok(call, `missing metadata object ${key}`);
  return JSON.parse(call.body);
}

type McpArgsResult =
  | { args: string[]; sideEffectFiles: string[]; agentToken: string | null }
  | { output: string; exitCode: number };

function createCommandCaptureExecutor(options: {
  envSecrets?: Record<string, string>;
  mcpArgsResult?: McpArgsResult;
  credentialsOverride?: Partial<{
    relayApiKey: string;
  }>;
} = {}): {
  executor: DaytonaStepExecutor;
  captured: { command?: string; env?: Record<string, string> };
  runtimeCommands: string[];
  runtimeCommandEnvs: Array<{ command: string; env?: Record<string, string> }>;
} {
  const runtimeCommands: string[] = [];
  const runtimeCommandEnvs: Array<{ command: string; env?: Record<string, string> }> = [];
  const captured: { command?: string; env?: Record<string, string> } = {};
  const daytona = {
    create: async () => ({
      id: "sandbox-id",
      process: {
        executeCommand: async (
          command: string,
          _cwd?: string,
          env?: Record<string, string>,
        ) => {
          runtimeCommands.push(command);
          runtimeCommandEnvs.push({ command, env });
          if (command.includes("mcp-args --register")) {
            const result = options.mcpArgsResult ?? {
              args: [],
              sideEffectFiles: [],
              agentToken: null,
            };
            if ("output" in result) {
              return { result: result.output, exitCode: result.exitCode };
            }
            return { result: JSON.stringify(result), exitCode: 0 };
          }
          if (command.includes("relayfile-initial-sync-exit:")) {
            return { result: "relayfile-initial-sync-exit:0", exitCode: 0 };
          }
          return { result: "ok", exitCode: 0 };
        },
      },
      fs: {
        uploadFile: async () => undefined,
      },
      getUserHomeDir: async () => "/home/daytona",
    }),
    remove: async () => undefined,
  };

  const executor = new DaytonaStepExecutor({
    daytona: daytona as any,
    credentials: {
      cliCredentials: "cli",
      relayApiKey: "relay",
      relayBaseUrl: "https://relay.test",
      runId: "run-1",
      userId: "user-1",
      workspaceId: "rw_abcd1234",
      daytonaApiKey: "day",
      s3CodeKey: "code.tar.gz",
      s3Credentials: {
        accessKeyId: "akid",
        secretAccessKey: "skey",
        sessionToken: "stoken",
        bucket: "bucket",
        prefix: "prefix",
      },
      ...(options.credentialsOverride ?? {}),
    },
    s3: {
      putObject: async () => undefined,
    } as any,
    relayfileUrl: "http://localhost:9090",
    relayfileToken: "test-token",
    envSecrets: options.envSecrets,
  });

  (executor as any).runCommand = async (
    _handle: unknown,
    command: string,
    env: Record<string, string>,
  ) => {
    captured.command = command;
    captured.env = env;
    return {
      output: "agent output",
      exitCode: 0,
    };
  };

  return { executor, captured, runtimeCommands, runtimeCommandEnvs };
}

function extractSingleQuotedArgAfter(command: string, marker: string): string {
  const markerIndex = command.indexOf(marker);
  assert.notEqual(markerIndex, -1, command);

  let cursor = markerIndex + marker.length;
  while (command[cursor] === " ") {
    cursor += 1;
  }
  assert.equal(command[cursor], "'", command);

  cursor += 1;
  let value = "";
  while (cursor < command.length) {
    if (command.startsWith("'\\''", cursor)) {
      value += "'";
      cursor += 4;
      continue;
    }
    if (command[cursor] === "'") {
      return value;
    }
    value += command[cursor];
    cursor += 1;
  }

  assert.fail(`Could not parse quoted arg after ${marker}`);
}

function countOccurrences(value: string, search: string): number {
  let count = 0;
  let cursor = 0;
  while (true) {
    const next = value.indexOf(search, cursor);
    if (next === -1) return count;
    count += 1;
    cursor = next + search.length;
  }
}
