import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateBootstrapScript } from "../../packages/core/src/bootstrap/script-generator.js";
import {
  buildRelayfileMountFlushShell,
  buildRelayfileMountPathArgsShell,
  buildRelayfileMountShellTemplate,
  buildRelayfileMountStartShell,
} from "../../packages/core/src/relayfile/mount-script.js";

function generateInnerScript(
  ...args: Parameters<typeof generateBootstrapScript>
): string {
  const result = generateBootstrapScript(...args);
  assert.equal(typeof result.inner, "string");
  return result.inner;
}

function extractGeneratedJsonConstant<T>(script: string, name: string): T {
  const match = new RegExp(`const ${name} = (\\{[^\\n]+\\});`).exec(script);
  assert.ok(match, `generated script should define ${name}`);
  return JSON.parse(match[1]);
}

function shellEscape(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

describe("generateBootstrapScript", () => {
  it("generates valid JavaScript for yaml type", () => {
    const script = generateInnerScript({ fileType: "yaml" });
    assert.ok(script.startsWith("#!/usr/bin/env node"));
    assert.ok(script.includes('"yaml"'));
    assert.ok(script.includes("import { Daytona }"));
    assert.ok(script.includes("import { WorkflowRunner }"));
    assert.ok(script.includes("const parsedConfig = applyMountedPathsToConfig(JSON.parse(workflowText));"));
    assert.ok(!script.includes("const yamlConfig = JSON.parse(workflowText);"));
  });

  it("generates valid JavaScript for typescript type", () => {
    const script = generateInnerScript({ fileType: "typescript" });
    assert.ok(script.includes('"typescript"'));
    assert.ok(script.includes("'npx', ['tsx'"));
  });

  it("imports TS workflow config and runs through executor path", () => {
    const script = generateInnerScript({ fileType: "typescript" });
    // Uses sentinel markers to safely extract config from noisy stdout
    assert.ok(script.includes("SENTINEL_START"));
    assert.ok(script.includes("SENTINEL_END"));
    assert.ok(script.includes("execFileSync('npx', ['tsx', '-e'"));
    assert.ok(script.includes("c.version && c.swarm"));
    assert.ok(script.includes("delete agent.permissions"));
    assert.ok(script.includes("return runWorkflow(runner, tsConfig)"));
    // Separate JSON.parse error handling
    assert.ok(script.includes("TS config JSON parse failed"));
  });

  it("generates valid JavaScript for python type", () => {
    const script = generateInnerScript({ fileType: "python" });
    assert.ok(script.includes('"python"'));
    assert.ok(script.includes("python3"));
  });

  it("uses custom codeMountPath when provided", () => {
    const script = generateInnerScript({
      fileType: "yaml",
      codeMountPath: "/workspace/code",
    });
    assert.ok(script.includes('"/workspace/code"'));
  });

  it("uses /project as default codeMountPath", () => {
    const script = generateInnerScript({ fileType: "yaml" });
    assert.ok(script.includes('"/project"'));
  });

  it("imports all required modules", () => {
    const script = generateInnerScript({ fileType: "yaml" });
    assert.ok(script.includes("ScopedS3Client"));
    assert.ok(script.includes("downloadAndExtractCode"));
    assert.ok(script.includes("writeRunManifest"));
    assert.ok(script.includes("DaytonaStepExecutor"));
    assert.ok(script.includes("Reporter"));
  });

  it("does not start a broker manually for non-interactive workflows", () => {
    const script = generateInnerScript({ fileType: "yaml" });
    assert.ok(!script.includes("agent-relay', 'broker', 'start"));
    assert.ok(script.includes("WorkflowRunner"));
    assert.ok(script.includes("DaytonaStepExecutor"));
  });

  it("imports Daytona, SandboxedStepExecutor and DaytonaRuntime in both interactive and non-interactive modes", () => {
    for (const interactive of [false, true]) {
      const script = generateInnerScript({ fileType: "yaml", interactive });
      assert.ok(
        script.includes("import { Daytona } from '@daytonaio/sdk'"),
        `Daytona import missing (interactive=${interactive})`,
      );
      assert.ok(
        script.includes("import { SandboxedStepExecutor }"),
        `SandboxedStepExecutor import missing (interactive=${interactive})`,
      );
      assert.ok(
        script.includes("import { DaytonaRuntime } from './lib/runtime/daytona.js'"),
        `DaytonaRuntime must import directly from daytona.js (interactive=${interactive})`,
      );
      assert.ok(
        !script.includes("from './lib/runtime/index.js'"),
        `runtime/index.js barrel import must not be used (interactive=${interactive}) — it eagerly loads E2BRuntime which requires the 'e2b' package not in the sandbox snapshot`,
      );
      assert.ok(
        script.includes("new SandboxedStepExecutor"),
        `SandboxedStepExecutor construction missing (interactive=${interactive})`,
      );
    }
  });

  it("strips agent permissions from parsed config before runner execution", () => {
    const script = generateInnerScript({ fileType: "yaml" });
    assert.ok(script.includes("delete agent.permissions"));
  });

  it("includes S3 credential env vars", () => {
    const script = generateInnerScript({ fileType: "yaml" });
    assert.ok(script.includes("S3_ACCESS_KEY_ID"));
    assert.ok(script.includes("S3_SECRET_ACCESS_KEY"));
    assert.ok(script.includes("S3_SESSION_TOKEN"));
    assert.ok(script.includes("S3_BUCKET"));
    assert.ok(script.includes("S3_PREFIX"));
  });

  it("threads cloud-api storage refresh tokens into bootstrap clients and step credentials", () => {
    const yamlScript = generateInnerScript({ fileType: "yaml" });
    assert.ok(yamlScript.includes("cloudApiRefreshToken: env.CLOUD_API_REFRESH_TOKEN"));

    const typescriptScript = generateInnerScript({ fileType: "typescript" });
    assert.ok(typescriptScript.includes('"    cloudApiRefreshToken: env.CLOUD_API_REFRESH_TOKEN,"'));
    assert.ok(typescriptScript.includes('"      cloudApiRefreshToken: env.CLOUD_API_REFRESH_TOKEN,"'));
    assert.ok(typescriptScript.includes('"    userId: env.USER_ID ?? \'\',"'));
  });

  it("handles CALLBACK_URL and CALLBACK_TOKEN", () => {
    const script = generateInnerScript({ fileType: "yaml" });
    assert.ok(script.includes("CALLBACK_URL"));
    assert.ok(script.includes("CALLBACK_TOKEN"));
    assert.ok(script.includes("Reporter"));
  });

  it("treats resume/start-from env vars as internal bootstrap controls", () => {
    const script = generateInnerScript({ fileType: "typescript" });
    assert.ok(script.includes("'RESUME_RUN_ID', 'START_FROM', 'PREVIOUS_RUN_ID'"));
  });

  it("treats shared-sandbox control env vars as internal bootstrap controls", () => {
    const script = generateInnerScript({ fileType: "typescript", executionMode: "shared-sandbox" });
    for (const key of [
      "WORKFLOW_EXECUTION_MODE",
      "WORKFLOW_OBSERVER_URL",
      "MSD_REVIEW_INPUT_JSON",
      "AGENT_WORKFORCE_SHARED_SANDBOX_ID",
      "AGENT_WORKFORCE_SHARED_WORKDIR",
    ]) {
      assert.ok(script.includes(`'${key}'`), `${key} should be reserved inside bootstrap env filtering`);
    }
  });

  it("passes resume and start-from env vars to WorkflowRunner", () => {
    const script = generateInnerScript({ fileType: "yaml" });
    assert.ok(script.includes("const workflowExecuteOptions = env.START_FROM"));
    assert.ok(script.includes("startFrom: env.START_FROM"));
    assert.ok(script.includes("previousRunId: env.PREVIOUS_RUN_ID"));
    assert.ok(script.includes("env.RESUME_RUN_ID"));
    assert.ok(script.includes("runner.resume(env.RESUME_RUN_ID, undefined, config)"));
    assert.ok(script.includes("runner.execute(config, undefined, undefined, workflowExecuteOptions)"));
    assert.ok(script.includes("return runWorkflow(runner, parsedConfig)"));
  });

  it("generates shared-sandbox bootstrap that writes MSD context and skips per-step executor construction", () => {
    const script = generateInnerScript({ fileType: "yaml", executionMode: "shared-sandbox" });

    assert.ok(script.includes("const configuredExecutionMode = \"shared-sandbox\""));
    assert.ok(script.includes("const sharedSandbox = executionMode === 'shared-sandbox'"));
    assert.ok(script.includes(".agent-workforce"));
    assert.ok(script.includes("msd-review"));
    assert.ok(script.includes("input.json"));
    assert.ok(script.includes("process.env.AGENT_WORKFORCE_SHARED_WORKDIR = brokerCwd"));
    assert.ok(script.includes("sharedSandbox\n    ? null\n    : new SandboxedStepExecutor"));
  });

  it("emits shared-sandbox lifecycle events with sandbox and workdir metadata", () => {
    const script = generateInnerScript({ fileType: "yaml", executionMode: "shared-sandbox" });

    for (const eventType of [
      "sandbox.created",
      "workflow.started",
      "agent.started",
      "agent.message",
      "artifact.updated",
      "artifact.finalized",
      "workflow.completed",
      "workflow.failed",
      "sandbox.stopping",
      "sandbox.stopped",
    ]) {
      assert.ok(script.includes(eventType), `expected ${eventType} in generated shared-sandbox event path`);
    }
    assert.ok(script.includes("executionMode: 'shared-sandbox'"));
    assert.ok(script.includes("workdir"));
    assert.ok(script.includes("delete payload.GITHUB_TOKEN"));
    assert.ok(script.includes("isMsdRelayReviewArtifact"));
    assert.ok(script.includes(".agent-workforce/msd-review/final-artifact.json"));
  });

  it("subscribes to runner step lifecycle and re-emits MSD events in shared-sandbox mode", () => {
    const script = generateInnerScript({ fileType: "yaml", executionMode: "shared-sandbox" });
    // The bootstrap must wire the SDK runner's on() callback so per-agent
    // step events flow through to the MSD shared-sandbox event stream.
    assert.ok(script.includes("attachSharedSandboxStepListeners"));
    assert.ok(script.includes("'step:started'"));
    assert.ok(script.includes("'step:completed'"));
    assert.ok(script.includes("'step:failed'"));
  });

  it("requires the MSD review final artifact in shared-sandbox mode (no silent completion)", () => {
    const script = generateInnerScript({ fileType: "yaml", executionMode: "shared-sandbox" });
    // The collector must throw when the file is missing so a partial run
    // cannot return a successful completion with no artifact attached.
    assert.ok(
      script.includes("MSD review final artifact is missing"),
      "missing artifact must throw, not silently fall back",
    );
    assert.ok(script.includes("MSD review final artifact was not collected"));
  });

  it("initializes reporter only when callback env vars present", () => {
    const script = generateInnerScript({ fileType: "yaml" });
    // Should conditionally create reporter
    assert.ok(script.includes("env.CALLBACK_URL && env.CALLBACK_TOKEN"));
  });


  it("wires broker API args when RELAY_BROKER_API_PORT is present", () => {
    const script = generateInnerScript({ fileType: "yaml" });
    assert.ok(script.includes("if (env.RELAY_BROKER_API_PORT)"));
    assert.ok(script.includes("binaryArgs.push('--api-port', env.RELAY_BROKER_API_PORT, '--api-bind', '0.0.0.0')"));
    assert.ok(script.includes("apiKey: env.RELAY_API_KEY ?? ''"));
    assert.ok(script.includes("process.env.RELAYFILE_URL = relayfileBaseUrl"));
  });

  it("includes error handling with process.exit", () => {
    const script = generateInnerScript({ fileType: "yaml" });
    assert.ok(script.includes("process.exitCode = 1"));
    assert.ok(script.includes("Bootstrap fatal error"));
  });

  it("preserves credential proxy env vars for non-interactive worker sandboxes", () => {
    const script = generateInnerScript({ fileType: "yaml" });

    assert.ok(script.includes("const forwardedEnvKeys = ["));
    for (const key of [
      "RELAY_LLM_PROXY",
      "RELAY_LLM_PROXY_URL",
      "OPENAI_BASE_URL",
      "ANTHROPIC_BASE_URL",
      "GOOGLE_API_BASE",
      "OPENAI_API_BASE",
      "CREDENTIAL_PROXY_TOKEN",
      "RELAY_LLM_PROXY_TOKEN",
    ]) {
      assert.ok(script.includes(`'${key}'`));
    }
    assert.ok(script.includes("envSecrets[key] = env[key];"));
    assert.ok(script.includes("...(Object.keys(envSecrets).length > 0 ? { envSecrets } : {}),"));
  });

  // Regression guard for #113: the `hasConfigExport` regex used to be written
  // as `/^export\s+(?:const\s+config\b|default\b)/m` inside a template literal,
  // which silently mangled to `/^exports+(?:consts+config|default)/m` in the
  // rendered bootstrap (`\s` has no string-escape meaning — the backslash is
  // stripped — and `\b` becomes U+0008 backspace). The regex compiled fine
  // but never matched a real `export const config` declaration, so every TS
  // workflow on cloud silently fell through to the standalone-script path.
  //
  // #110 fixed the source (double the backslashes so they survive the
  // template-literal pass). This test extracts the actual regex from the
  // rendered bootstrap output, compiles it, and exercises it against known
  // samples. It catches the original bug directly AND any future edit that
  // re-introduces a single-backslash regex on this line.
  it("hasConfigExport regex in rendered bootstrap correctly matches TS config exports (regression for #113)", () => {
    const script = generateInnerScript({ fileType: "typescript" });
    const match = script.match(
      /hasConfigExport\s*=\s*(\/[^\n]+\/[a-z]*)\s*\.test\(sourceText\)/,
    );
    assert.ok(
      match,
      "generated bootstrap should contain a `hasConfigExport = /.../m.test(sourceText)` line",
    );

    const [, regexLiteral] = match;
    const lastSlash = regexLiteral.lastIndexOf("/");
    const pattern = regexLiteral.slice(1, lastSlash);
    const flags = regexLiteral.slice(lastSlash + 1);
    const rendered = new RegExp(pattern, flags);

    // Real exports the bootstrap must detect.
    assert.ok(
      rendered.test('export const config: RelayYamlConfig = { version: "1.0" };'),
      `regex must match \`export const config\` declarations; got ${regexLiteral}`,
    );
    assert.ok(
      rendered.test('export default { version: "1.0" };'),
      `regex must match \`export default\` declarations; got ${regexLiteral}`,
    );

    // Prose mentioning `exports`/`export` in a comment must NOT match.
    assert.equal(
      rendered.test("// exports the config below"),
      false,
      `regex must not match prose comments; got ${regexLiteral}`,
    );
    assert.equal(
      rendered.test("// export something"),
      false,
      `regex must not match arbitrary export-prefixed comments; got ${regexLiteral}`,
    );

    // The bug smoking-gun: if `\s` got mangled, the pattern becomes
    // `exports+(?:consts+config|default)` which matches literal `exports` —
    // assert we do NOT match that shape.
    assert.equal(
      rendered.test("exports config"),
      false,
      `regex must not match literal 'exports config' — if it does, \\s was template-stripped; got ${regexLiteral}`,
    );
  });

  it("writes a .git pointer file so workflow commands see $brokerCwd as a git repo", () => {
    // Regression: workflows that run `git status` from /project used to
    // fail with "not a git repository" because the baseline used a
    // separate GIT_DIR env override instead of a standard .git pointer.
    const script = generateInnerScript({ fileType: "typescript" });
    assert.ok(
      script.includes("'gitdir: ' + gitDir + '\\n'"),
      "generated script should write `gitdir: <gitDir>` pointer at $brokerCwd/.git",
    );
    assert.ok(
      script.includes("pathJoin(brokerCwd, '.git')"),
      "pointer file must live at $brokerCwd/.git, not the separate gitDir",
    );
  });

  it("does not overwrite an existing .git directory (Codex P2)", () => {
    // Previously `writeFile($brokerCwd/.git, ...)` threw EISDIR and aborted
    // the whole baseline block when the user's tarball included a
    // pre-cloned repo. Guard by stat+isDirectory check before writing.
    const script = generateInnerScript({ fileType: "typescript" });
    assert.ok(
      script.includes("existingGit.isDirectory()"),
      "must stat .git and skip pointer write if it's already a real directory",
    );
    assert.ok(
      script.includes(".git already exists as a directory"),
      "should log when an existing .git directory is preserved",
    );
  });

  it("writes bootstrap ignore rules to gitDir/info/exclude, not $brokerCwd/.gitignore (Devin/Codex P1)", () => {
    // Regression: writing `.gitignore` into $brokerCwd clobbers the user's
    // ignore rules extracted from S3. Use git's per-repo info/exclude
    // instead — honored by git status/add like .gitignore but lives in
    // the gitdir so it never touches the worktree.
    const script = generateInnerScript({ fileType: "typescript" });
    assert.ok(
      script.includes("pathJoin(gitDir, 'info')"),
      "must write exclude rules under gitDir/info/",
    );
    assert.ok(
      script.includes("pathJoin(excludeDir, 'exclude')"),
      "must write to git's standard info/exclude path",
    );
    assert.ok(
      !script.includes("pathJoin(brokerCwd, '.gitignore')"),
      "must NOT write .gitignore inside $brokerCwd — that clobbers the user's rules",
    );
    // Scratch-dir entries are still present
    assert.ok(script.includes("'.agent-relay/'"));
    assert.ok(script.includes("'.relay/'"));
    assert.ok(script.includes("'.relayfile-mount-state.json'"));
  });

  it("seeds relayfile with initial code BEFORE starting the watch daemon", () => {
    // Regression: per-agent sandboxes run `relayfile-mount --once` to
    // populate /project from the relayfile workspace. If the orchestrator
    // only started the watching daemon without an initial push, relayfile
    // stays empty because the daemon watches for FS events — it doesn't
    // push pre-existing files. Agent steps spawning before the daemon
    // happens to sync everything would see an empty /project.
    //
    // The generated script must call flushRelayfileMountOnce BEFORE
    // startRelayfileMountDaemon, so any per-agent sandbox that spawns
    // after the bootstrap is ready can pull the user's code.
    const script = generateInnerScript({ fileType: "typescript" });
    const seedIdx = script.indexOf("Seeding relayfile workspace");
    const daemonIdx = script.indexOf("relayfileMountPid = startRelayfileMountDaemon");
    assert.ok(seedIdx > 0, "must log 'Seeding relayfile workspace' before starting daemon");
    assert.ok(daemonIdx > 0, "must still start the watch daemon");
    assert.ok(
      seedIdx < daemonIdx,
      "initial relayfile seed must happen BEFORE daemon start to avoid racing per-agent sandbox spawns",
    );
    assert.ok(
      script.includes("await flushRelayfileMountOnce(relayfileRoot)"),
    );
  });

  it("emits relayfile-mount commands from the shared canonical builder", () => {
    const script = generateInnerScript({ fileType: "typescript" });
    const generatedTemplate = extractGeneratedJsonConstant<ReturnType<typeof buildRelayfileMountShellTemplate>>(
      script,
      "relayfileMountShellTemplate",
    );
    const canonicalTemplate = buildRelayfileMountShellTemplate(
      {},
      { interval: "3s", websocket: false },
    );
    const opts = {
      baseUrl: "https://relayfile.example",
      workspaceId: "rw_abc12345",
      localDir: "/home/daytona/workspace",
      token: "relay_pa_token",
      paths: ["/github/repos/**", "/linear/issues/**"],
      interval: "3s",
      websocket: false,
    };
    const pathArgs = buildRelayfileMountPathArgsShell(opts.paths);
    const render = (template: string) => template
      .replace(shellEscape(generatedTemplate.placeholders.baseUrl), shellEscape(opts.baseUrl))
      .replace(shellEscape(generatedTemplate.placeholders.workspaceId), shellEscape(opts.workspaceId))
      .replace(shellEscape(generatedTemplate.placeholders.localDir), shellEscape(opts.localDir))
      .replace(shellEscape(generatedTemplate.placeholders.token), shellEscape(opts.token))
      .replace(generatedTemplate.pathArgsPlaceholderArg, pathArgs);

    assert.deepEqual(generatedTemplate, canonicalTemplate);
    assert.ok(buildRelayfileMountStartShell(opts).includes(render(generatedTemplate.startShellTemplate)));
    assert.ok(script.includes("function relayfileMountSupportsMultiPath()"));
    assert.ok(script.includes("roots.length > 1 && !relayfileMountSupportsMultiPath()"));
    assert.ok(script.includes("relayfileMountFallbackStartShell(localDir, roots)"));
    assert.equal(render(generatedTemplate.flushShellTemplate), buildRelayfileMountFlushShell(opts));
    assert.ok(!script.includes("'nohup relayfile-mount --base-url ' +"));
    assert.ok(!script.includes("'relayfile-mount --once --base-url ' +"));
    assert.ok(!script.includes("' --paths ' +"));
  });

  it("supports Phase B path tarballs under /home/daytona/workspace/{name}", () => {
    const script = generateInnerScript({ fileType: "typescript" });
    assert.ok(script.includes("const workspaceMountPath = '/home/daytona/workspace'"));
    assert.ok(script.includes("const submittedPaths = parseSubmittedPaths()"));
    assert.ok(script.includes("await downloadAndExtractCode(s3, entry.s3CodeKey, sandboxFs, entry.mountPath)"));
    assert.ok(script.includes("workspaceMountPath + '/.relay'"));
    assert.ok(script.includes("'/paths.json'"));
  });

  it("sets up per-path baselines and patch uploads", () => {
    const script = generateInnerScript({ fileType: "typescript" });
    assert.ok(script.includes("function gitDirForPath(pathName)"));
    assert.ok(script.includes("async function setupGitBaselineForMountedPath(entry)"));
    assert.ok(script.includes("GIT_DIR=' + pathGitDir + ' GIT_WORK_TREE=' + brokerCwd"));
    assert.ok(script.includes("for (const entry of submittedPaths)"));
    assert.ok(script.includes("await uploadPatchForMountedPath(entry)"));
    assert.ok(script.includes("'changes-' + entry.name + '.patch'"));
  });

  it("git-inits a sentinel repo at workspaceMountPath for multi-path runs (covers cwd auto-detect)", () => {
    // cloud#437 set brokerCwd = workspaceMountPath. CLIs that auto-
    // detect git context (codex, claude) inherit cwd by default and
    // would crash with "fatal: not a git repository" because per-mount
    // baselines live INSIDE each mountPath. The sentinel makes the
    // workspace root a valid (empty) git repo so those tools succeed.
    const script = generateInnerScript({ fileType: "typescript" });
    assert.ok(
      script.includes("'git -C ' + workspaceMountPath + ' init -q'"),
      "bootstrap must git-init the workspace root for multi-path runs",
    );
    // Probe HEAD specifically — not just is-inside-work-tree — so a
    // partially initialized state from a prior crashed bootstrap (init
    // succeeded but empty commit didn't) re-enters the recovery path
    // instead of being misclassified as healthy.
    assert.ok(
      script.includes("'git -C ' + workspaceMountPath + ' rev-parse --verify HEAD'"),
      "sentinel idempotency probe must verify HEAD, not just repo presence, so half-initialized states recover",
    );
    assert.ok(
      !script.includes("'git -C ' + workspaceMountPath + ' rev-parse --is-inside-work-tree'"),
      "the previous is-inside-work-tree probe is too lax (passes for repos with no HEAD) and must not coexist with the HEAD probe",
    );
    assert.ok(
      script.includes('"workspace-root sentinel"'),
      "sentinel init must seal with an empty commit so tools see a populated repo",
    );
  });

  it("commits the full worktree at baseline (clean-tree check) with empty-commit fallback", () => {
    const script = generateInnerScript({ fileType: "typescript" });
    // Stage 1: full commit. Makes `git status --porcelain` empty on a
    // fresh run so workflow clean-tree guards pass as they would locally.
    assert.ok(script.includes("git add -A"));
    assert.ok(
      script.includes('"baseline" --allow-empty'),
      'baseline commit should use -m "baseline" with --allow-empty fallback',
    );
    // Stage 2: empty commit fallback. Preserves legacy fast path when
    // `git add -A` times out on pathological volumes.
    assert.ok(script.includes("committedFull = true"));
    assert.ok(script.includes("Full-tree baseline timed out"));
    assert.ok(script.includes('--allow-empty -m "baseline"'));
  });

  it("resolves the uploaded workflow file against the synced code tree so relative imports work", () => {
    // When --sync-code uploads the repo to codeMountPath AND the launcher
    // separately uploads the workflow source to $HOME, the generated bootstrap
    // must reunite them by finding the byte-identical copy in the synced
    // tree. Without this, 'import ... from "../shared/models.js"' resolves
    // against $HOME and fails with "Cannot find module".
    const script = generateInnerScript({ fileType: "typescript" });
    // Gate: only runs when code was synced and file is outside the mount.
    assert.ok(script.includes("(env.S3_CODE_KEY || hasPathMounts) && !workflowFile.startsWith(workflowSearchRoot)"));
    // Uses the sha256-based resolver helper.
    assert.ok(script.includes("findWorkflowFileInSyncedTree(workflowFile, workflowSearchRoot)"));
    // Helper is defined in the rendered script.
    assert.ok(script.includes("async function findWorkflowFileInSyncedTree("));
    // Helper uses sha256 content matching and filters expensive dirs.
    assert.ok(script.includes("createHash('sha256')"));
    assert.ok(script.includes("'node_modules'"));
    // workflowFile must be mutable so the resolved path can replace it.
    assert.ok(script.includes("let workflowFile = env.WORKFLOW_FILE"));
  });

  it("emits the running heartbeat before any setup that could exceed the reaper timeout", () => {
    // The stuck-run-reaper kills any 'pending' run older than
    // STUCK_RUN_TIMEOUT_MINUTES. The heartbeat must fire before any
    // potentially-slow setup (credential refresh, initializeWorkflow,
    // relayfile seeding+retries, manifest write) so a healthy long run
    // can never be falsely reaped.
    const script = generateInnerScript({ fileType: "yaml" });

    const heartbeatIdx = script.indexOf("reporter.reportStatus(runId, 'running')");
    assert.ok(heartbeatIdx > -1, "expected a running-status heartbeat call");

    const refreshIdx = script.indexOf("await refreshExpiringCredentials()");
    const initIdx = script.indexOf("await initializeWorkflow()");
    const seedIdx = script.indexOf("flushRelayfileMountOnce(relayfileRoot)");
    const manifestIdx = script.indexOf("await writeRunManifest(s3, manifest)");

    assert.ok(refreshIdx > -1 && initIdx > -1 && seedIdx > -1 && manifestIdx > -1,
      "expected refreshExpiringCredentials, initializeWorkflow, flushRelayfileMountOnce, writeRunManifest in script");
    assert.ok(heartbeatIdx < refreshIdx, "heartbeat must precede credential refresh");
    assert.ok(heartbeatIdx < initIdx, "heartbeat must precede initializeWorkflow");
    assert.ok(heartbeatIdx < seedIdx, "heartbeat must precede relayfile seed");
    assert.ok(heartbeatIdx < manifestIdx, "heartbeat must precede writeRunManifest");
  });

  it("brokerCwd: multi-path runs use workspaceMountPath as cwd (parent of all mounts)", () => {
    // Regression history:
    //   - Pre-Phase-B: $HOME fallback for type==='config' && !codeKey ran
    //     the broker from /home/daytona which was empty for multi-path
    //     submissions and broke relative imports (Phase B P1 fix).
    //   - Post-Phase-B: cwd was set to submittedPaths[0].mountPath, which
    //     made the SDK runner's resolvePathDefinitions resolve
    //     paths[].path against the first mount and produce duplicated
    //     paths like /home/daytona/workspace/alpha/alpha that don't
    //     exist. Validation threw "Path 'alpha' resolves to ... which
    //     does not exist (required)" before the first step ran.
    //
    // Current contract: cwd is workspaceMountPath (the parent of all
    // mounts). Local-mode semantics: declared paths are relative to the
    // workflow file's parent and cwd is set to that parent. Cloud-mode
    // is now symmetric: cwd is the parent of the path mounts.
    const script = generateInnerScript({ fileType: "yaml" });

    // Multi-path branch must select workspaceMountPath, NOT
    // submittedPaths[0].mountPath.
    assert.ok(
      script.includes("hasPathMounts ? workspaceMountPath : codeMountPath"),
      "brokerCwd path branch must select workspaceMountPath when hasPathMounts is true",
    );
    assert.ok(
      !script.includes("hasPathMounts ? submittedPaths[0].mountPath : codeMountPath"),
      "brokerCwd must no longer use submittedPaths[0].mountPath — that caused SDK runner path validation to double-prefix declared paths",
    );
    // The $HOME fallback still requires !hasPathMounts so empty config
    // runs route to $HOME but multi-path runs do not.
    assert.ok(
      script.includes("type === 'config' && !codeKey && !hasPathMounts"),
      "brokerCwd $HOME fallback must still require !hasPathMounts",
    );
  });

  it("emits workflow.started after initializeWorkflow rewrites brokerCwd, not before", () => {
    // Regression for the case where workflow.started reported the
    // placeholder codeMountPath while sandbox.created reported the real
    // post-initialize workdir, leaving observers with two conflicting
    // workdirs for the same run.
    const script = generateInnerScript({ fileType: "yaml", executionMode: "shared-sandbox" });
    const initIdx = script.indexOf("const init = await initializeWorkflow()");
    const startedIdx = script.indexOf("emitMsdSharedSandboxReviewEvent('workflow.started'");
    const createdIdx = script.indexOf("emitMsdSharedSandboxReviewEvent('sandbox.created'");
    assert.ok(initIdx > 0, "expected initializeWorkflow() call in generated script");
    assert.ok(startedIdx > 0, "expected workflow.started emission");
    assert.ok(createdIdx > 0, "expected sandbox.created emission");
    assert.ok(
      startedIdx > initIdx,
      "workflow.started must be emitted AFTER initializeWorkflow() so brokerCwd is finalized",
    );
    assert.ok(
      createdIdx > initIdx,
      "sandbox.created must be emitted AFTER initializeWorkflow()",
    );
  });
});
