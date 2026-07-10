import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GITHUB_UPSERT_WRITEBACK_PATH,
  SLACK_UPSERT_WRITEBACK_PATH,
} from "../../packages/relayfile/src/writeback/path-eligibility";
import { transformSync } from "esbuild";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const runtimeMocks = vi.hoisted(() => ({
  draftFile: vi.fn(),
  encodeSegment: vi.fn(),
  writeJsonFile: vi.fn(),
}));

vi.mock("@agentworkforce/runtime", () => ({
  defineAgent: (spec: Record<string, unknown>) => spec,
  draftFile: runtimeMocks.draftFile,
  encodeSegment: runtimeMocks.encodeSegment,
  handler: (fn: unknown) => fn,
  writeJsonFile: runtimeMocks.writeJsonFile,
}));

const agentModule = await import("./agent");
const agentExport = agentModule.default as unknown;
const handleEvent = (
  typeof agentExport === "function"
    ? agentExport
    : (agentExport as { handler: unknown }).handler
) as (ctx: any, event: any) => Promise<void>;
const { handleSlackMessage, workflowSource } = agentModule;

const EXPECTED_AGENT_TRIGGERS = {
  github: [
    {
      on: "issues.opened",
      paths: ["/github/repos/AgentWorkforce/cloud/issues/**"],
    },
    {
      on: "issues.labeled",
      paths: ["/github/repos/AgentWorkforce/cloud/issues/**"],
    },
  ],
  slack: [
    {
      on: "message",
      paths: ["/slack/channels/C0AD7UU0J1G/messages/**"],
    },
  ],
};

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.RELAYFILE_URL = "https://relayfile.test";
  process.env.RELAYFILE_TOKEN = "relayfile-token";
  process.env.RELAYFILE_WORKSPACE_ID = "workspace-1";
  process.env.CLOUD_API_URL = "https://cloud.test";
  process.env.CLOUD_API_ACCESS_TOKEN = "cloud-token";
  runtimeMocks.draftFile.mockReset();
  runtimeMocks.encodeSegment.mockReset();
  runtimeMocks.writeJsonFile.mockReset();
  runtimeMocks.draftFile.mockImplementation((label: string) =>
    `draft-${label.replace(/[^a-z0-9]+/giu, "-").toLowerCase()}.json`
  );
  runtimeMocks.encodeSegment.mockImplementation((value: string | number) =>
    encodeURIComponent(String(value))
  );
  runtimeMocks.writeJsonFile.mockImplementation(async (_client, _provider, _operation, relayPath) => ({
    path: relayPath,
    absolutePath: `/tmp/relayfile${relayPath}`,
    receipt: { created: "1710000000.000001" },
  }));
});

afterEach(() => {
  expectWriteJsonPathsMatchWritebackAllowlist();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

describe("cloud-small-issue-codex agent declaration", () => {
  it("declares GitHub and Slack deploy triggers in the top-level agent block", () => {
    expect(agentExport).toMatchObject({
      triggers: EXPECTED_AGENT_TRIGGERS,
    });
  });
});

describe("cloud-small-issue-codex Slack follow-up handling", () => {
  it("ignores bot-authored thread replies to avoid answering itself", async () => {
    const ctx = {
      files: {
        read: vi.fn(),
        write: vi.fn(),
      },
      harness: {
        run: vi.fn(),
      },
      slack: {
        reply: vi.fn(),
      },
    };

    await handleSlackMessage(ctx, {
      id: "evt_bot_reply_1",
      type: "relaycast.message",
      channel: "proj-cloud",
      resource: {
        path: "/relaycast/proj-cloud/messages/evt_bot_reply_1",
        kind: "relaycast.message",
        id: "evt_bot_reply_1",
        provider: "relaycast",
      },
      expand: async () => ({
        level: "full",
        path: "/relaycast/proj-cloud/messages/evt_bot_reply_1",
        data: {
          channel: "proj-cloud",
          thread_ts: "1710000000.000001",
          ts: "1710000001.000002",
          text: "Agent answer echoed back from Slack",
          bot_id: "B123",
          subtype: "bot_message",
        },
      }),
    });

    expect(ctx.files.read).not.toHaveBeenCalled();
    expect(ctx.files.write).not.toHaveBeenCalled();
    expect(ctx.harness.run).not.toHaveBeenCalled();
    expect(ctx.slack.reply).not.toHaveBeenCalled();
  });
});

describe("cloud-small-issue-codex workflow source", () => {
  it("opens pull requests through the Cloud proxy endpoint instead of sandbox GitHub tokens", () => {
    const source = workflowSource({
      issueNumber: 123,
      issueTitle: "Example issue",
      issueBody: "Body",
      issueUrl: "https://github.com/AgentWorkforce/cloud/issues/123",
    });

    expect(source).not.toContain("createGitHubStep");
    expect(source).not.toContain("GITHUB_TOKEN");
    expect(source).not.toContain("https://api.github.com");
    expect(source).not.toContain("git push");
    expect(source).toContain("/api/v1/github/clone/request");
    expect(source).toContain("/api/v1/github/pull-request");
    expect(source).toContain("RELAYFILE_WORKSPACE_ID");
    expect(source).toContain("const MATERIALIZE_SCRIPT = LEGACY_MATERIALIZE_SCRIPT;");
    expect(() => transformSync(source, { loader: "ts", format: "esm" })).not.toThrow();
  });

  it("selects the archive lease materializer only when the runtime persona input enables it", () => {
    const offSource = workflowSource({
      issueNumber: 123,
      issueTitle: "Archive lease off",
      issueBody: "Body",
      issueUrl: "https://github.com/AgentWorkforce/cloud/issues/123",
    });
    const onSource = workflowSource({
      issueNumber: 123,
      issueTitle: "Archive lease on",
      issueBody: "Body",
      issueUrl: "https://github.com/AgentWorkforce/cloud/issues/123",
      archiveLeaseMaterializeEnabled: true,
    });

    expect(offSource).toContain("const MATERIALIZE_SCRIPT = LEGACY_MATERIALIZE_SCRIPT;");
    expect(onSource).toContain("const MATERIALIZE_SCRIPT = ARCHIVE_LEASE_MATERIALIZE_SCRIPT;");
  });

  it("reads deterministic helper credentials from canonical sandbox env names", () => {
    const source = workflowSource({
      issueNumber: 131,
      issueTitle: "Credential env issue",
      issueBody: "Body",
      issueUrl: "https://github.com/AgentWorkforce/cloud/issues/131",
    });
    const materializeScript = extractRawScript(source, "LEGACY_MATERIALIZE_SCRIPT");
    const archiveLeaseScript = extractRawScript(source, "ARCHIVE_LEASE_MATERIALIZE_SCRIPT");
    const createPrScript = extractRawScript(source, "CREATE_PROXY_PR_SCRIPT");

    expect(materializeScript).toContain("process.env[name]");
    expect(materializeScript).toContain("readCredentialUrl('RELAYFILE_URL')");
    expect(materializeScript).toContain("readCredential('RELAYFILE_TOKEN')");
    expect(materializeScript).toContain("readCredential('RELAYFILE_WORKSPACE_ID')");
    expect(materializeScript).toContain("readCredentialUrl('CLOUD_API_URL')");
    expect(materializeScript).toContain("readCredential('CLOUD_API_ACCESS_TOKEN')");
    expect(materializeScript).not.toContain("RELAYFILE_BASE_URL");
    expect(materializeScript).not.toContain("WORKFORCE_WORKSPACE_ID");
    expect(materializeScript).not.toContain("RELAYFILE_WORKSPACE ||");
    expect(materializeScript).not.toContain("RELAY_WORKSPACE_ID");
    expect(materializeScript).not.toContain("WORKFORCE_WORKSPACE_TOKEN");

    expect(archiveLeaseScript).toContain("readCredentialUrl('CLOUD_API_URL')");
    expect(archiveLeaseScript).toContain("readCredential('WORKFORCE_WORKSPACE_TOKEN')");
    expect(archiveLeaseScript).toContain("readCredential('RUN_ID')");
    expect(archiveLeaseScript).not.toContain("readCredential('CLOUD_API_ACCESS_TOKEN')");

    expect(createPrScript).toContain("requireRuntimeCredentials({ relayfile: false, cloudApi: true })");
    expect(createPrScript).toContain("readCredentialUrl('CLOUD_API_URL')");
    expect(createPrScript).toContain("readCredential('CLOUD_API_ACCESS_TOKEN')");
    expect(createPrScript).toContain("readCredential('WORKFORCE_WORKSPACE_TOKEN')");
  });

  it("prefers the forwarded relayfile persona token for proxy pull request auth", () => {
    const source = workflowSource({
      issueNumber: 133,
      issueTitle: "Proxy PR auth issue",
      issueBody: "Body",
      issueUrl: "https://github.com/AgentWorkforce/cloud/issues/133",
    });
    const createPrScript = extractRawScript(source, "CREATE_PROXY_PR_SCRIPT");

    expect(createPrScript).toContain(
      "const pullRequestAuthToken = readCredential('WORKFORCE_WORKSPACE_TOKEN') || cloudApiToken;",
    );
    expect(createPrScript).toContain(
      "headers: { authorization: 'Bearer ' + pullRequestAuthToken, 'content-type': 'application/json' }",
    );
    expect(createPrScript).not.toContain("authorization: 'Bearer ' + cloudApiToken");
  });

  it("keeps duplicated sandbox credential helpers byte-identical", () => {
    const source = workflowSource({
      issueNumber: 132,
      issueTitle: "Credential helper drift issue",
      issueBody: "Body",
      issueUrl: "https://github.com/AgentWorkforce/cloud/issues/132",
    });

    expect(extractSandboxCredentialHelper(extractRawScript(source, "CREATE_PROXY_PR_SCRIPT"))).toBe(
      extractSandboxCredentialHelper(extractRawScript(source, "LEGACY_MATERIALIZE_SCRIPT")),
    );
  });

  it("materializes the relayfile clone and uses the deterministic branch name", () => {
    const source = workflowSource({
      issueNumber: 124,
      issueTitle: "Another issue",
      issueBody: "Body",
      issueUrl: "https://github.com/AgentWorkforce/cloud/issues/124",
    });

    expect(source).toContain("const REPO = 'AgentWorkforce/cloud';");
    expect(source).toContain("const REPO_DIR = './cloud';");
    expect(source).not.toContain("const REPO_DIR = '/tmp/cloud-small-issue-' + ISSUE_NUMBER + '/cloud';");
    expect(source).toContain("const BRANCH = 'codex/small-issue-' + ISSUE_NUMBER;");
    expect(source).toContain("clone.json");
    expect(source).toContain("execFileSync('git', ['init']");
    expect(source).toContain("['diff', '--name-only'");
    expect(source).not.toContain("Date.now() + ISSUE_NUMBER");
  });

  it("keeps materialize, implement, and open-pr on the propagated mount path", () => {
    const source = workflowSource({
      issueNumber: 134,
      issueTitle: "Mounted repo path issue",
      issueBody: "Body",
      issueUrl: "https://github.com/AgentWorkforce/cloud/issues/134",
    });

    expect(source).toContain("const REPO_DIR = './cloud';");
    expect(source).not.toContain("const REPO_DIR = '/tmp/");
    expect(source).toContain("targetDir] = process.argv.slice(2)");
    expect(source).toContain("'Work in ' + REPO_DIR + ' on branch ' + BRANCH + '.'");
    expect(source).toContain("const [repoDir, owner, repo, branch, title, body] = process.argv.slice(2);");
    expect(source).toContain("'node ' + [\n        '/tmp/cloud-small-issue-materialize.cjs',\n        'AgentWorkforce',\n        'cloud',\n        REPO_DIR");
    expect(source).toContain("'node ' + [\n        '/tmp/cloud-small-issue-create-pr.cjs',\n        REPO_DIR,");
  });

  it("waits for the specific async clone job before materializing cached contents", () => {
    const source = workflowSource({
      issueNumber: 127,
      issueTitle: "Clone race issue",
      issueBody: "Body",
      issueUrl: "https://github.com/AgentWorkforce/cloud/issues/127",
    });
    const script = extractRawScript(source, "LEGACY_MATERIALIZE_SCRIPT");

    expect(script).toContain("return payload.jobId;");
    expect(script).toContain("/api/v1/github/clone/status/");
    expect(script).toContain("const cloneJobId = await requestClone();");
    expect(script).toContain("const cloneJob = await waitForCloneJob(cloneJobId);");
    expect(script).toContain("const materialization = job.materialization || null;");
    expect(script).toContain("mode === 'relayfile_export'");
    expect(script).toContain("const materialization = resolveMaterialization(cloneJob);");
    expect(script).toContain("const headSha = materialization.headSha;");
    expect(script).toContain("const CLONE_WAIT_TIMEOUT_MS = 25 * 60 * 1000;");
    expect(script).toContain("Date.now() + CLONE_WAIT_TIMEOUT_MS");
    expect(script).toContain("let lastError = '';");
    expect(script).toContain("last poll error");
    expect(script).toContain("isRetryableCloneStatusPollError(error)");
    expect(script).toContain("parsed.headSha === expectedHeadSha");
    expect(script).toContain("filesWritten !== materialization.filesExpected");
    expect(() => transformSync(script, { loader: "js", format: "cjs" })).not.toThrow();
  });

  it("materializes the clone with one decoded subtree tar export", () => {
    const source = workflowSource({
      issueNumber: 128,
      issueTitle: "Clone readback perf issue",
      issueBody: "Body",
      issueUrl: "https://github.com/AgentWorkforce/cloud/issues/128",
    });
    const script = extractRawScript(source, "LEGACY_MATERIALIZE_SCRIPT");

    expect(script).toContain("/fs/export?");
    expect(script).toContain("format', 'tar'");
    expect(script).toContain("pathPrefix', contentRoot");
    expect(script).toContain("decode', 'github-working-tree'");
    expect(script).toContain("headSha', headSha");
    expect(script).toContain("gzip', '0'");
    expect(script).toContain("const EXPORT_FETCH_TIMEOUT_MS = 300 * 1000;");
    expect(script).toContain("const EXPORT_FETCH_MAX_ATTEMPTS = 3;");
    expect(script).toContain("AbortController");
    expect(script).toContain("signal: controller.signal");
    expect(script).toContain("Relayfile decoded export attempt ' + attempt + ' failed; retrying");
    expect(script).toContain("await fs.rm(tarPath, { force: true })");
    expect(script).toContain("await fs.rm(targetDir, { recursive: true, force: true });");
    expect(script).toContain("await fs.mkdir(targetDir, { recursive: true });");
    expect(script).toContain("nodeFs.createWriteStream(tarPath)");
    expect(script).toContain("execFileSync('tar', ['-tf', tarPath]");
    expect(script).toContain("const args = ['-xf', tarPath, '-C', targetDir];");
    expect(script).toContain("execFileSync('tar', args, { stdio: 'inherit' });");
    expect(script).toContain("Clone materialization tar contained");
    expect(script).not.toContain("['-xz', '-C', targetDir]");
    expect(script).toContain("const filesWritten = await countMaterializedFiles(targetDir);");
    expect(script).not.toContain("async function listTree");
    expect(script).not.toContain("repoPathFromCachePath");
    expect(script).not.toContain("await readFile(entry.path)");
    expect(() => transformSync(script, { loader: "js", format: "cjs" })).not.toThrow();
  });

  it("supports the local archive materialization contract without Relayfile export", () => {
    const source = workflowSource({
      issueNumber: 133,
      issueTitle: "Local archive materialization issue",
      issueBody: "Body",
      issueUrl: "https://github.com/AgentWorkforce/cloud/issues/133",
    });
    const script = extractRawScript(source, "LEGACY_MATERIALIZE_SCRIPT");

    expect(script).toContain("if (materialization.mode === 'local_archive')");
    expect(script).toContain("archiveUrl: materialization.archiveUrl");
    expect(script).toContain("stripComponents: Number.isInteger(materialization.stripComponents)");
    expect(script).toContain("resolveCloudArchiveUrl(materialization.archiveUrl)");
    expect(script).toContain("local_archive archiveUrl must use Cloud API origin");
    expect(script).toContain("fetchLocalArchiveToTar(materialization, tarPath)");
    expect(script).toContain("authorization: 'Bearer ' + cloudApiToken");
    expect(script).toContain("args.push('--strip-components', String(options.stripComponents));");
    expect(script).toContain("materializationMode: materialization.mode");
    expect(script).toContain("await waitForSentinel(headSha);");
    expect(script).toContain("tarEntries = await extractDecodedCloneExport(headSha);");
    expect(() => transformSync(script, { loader: "js", format: "cjs" })).not.toThrow();
  });

  it("materializes with an archive lease, fresh direct tarball fetches, and resolved clone metadata", () => {
    const source = workflowSource({
      issueNumber: 135,
      issueTitle: "Archive lease materialization issue",
      issueBody: "Body",
      issueUrl: "https://github.com/AgentWorkforce/cloud/issues/135",
      archiveLeaseMaterializeEnabled: true,
    });
    const script = extractRawScript(source, "ARCHIVE_LEASE_MATERIALIZE_SCRIPT");

    expect(script).toContain("/api/v1/workflows/runs/");
    expect(script).toContain("/clone/archive-lease");
    expect(script).toContain("body: JSON.stringify({ owner, repo, ref: 'HEAD' })");
    expect(script).toContain("authorization: 'Bearer ' + workspaceToken");
    expect(script).toContain("fetch(lease.url, { signal: controller.signal })");
    expect(script).toContain("const lease = await requestArchiveLease();");
    expect(script).toContain("retrying with a fresh archive lease");
    expect(script).toContain("execFileSync('tar', ['-tzf', tarPath]");
    expect(script).toContain("options.gzip ? '-xzf' : '-xf'");
    expect(script).toContain("stripComponents: 1, gzip: true");
    expect(script).toContain("sst.config.ts");
    expect(script).toContain("package.json");
    expect(script).toContain("tarball_extract_failed");
    expect(script).toContain("const headSha = materialization.headSha;");
    expect(script).toContain("materializationMode: 'archive_lease'");
    expect(script).not.toContain("/api/v1/github/clone/request");
    expect(script).not.toContain("/api/v1/github/clone/status/");
    expect(script).not.toContain("/fs/export?");
    expect(script).not.toContain("decode', 'github-working-tree'");
    expect(script).not.toContain("local_archive");
    expect(script).not.toContain("resolveCloudArchiveUrl");
    expect(() => transformSync(script, { loader: "js", format: "cjs" })).not.toThrow();
  });

  it("counts archive tar entries by splitting actual newlines in the generated helper script", () => {
    const source = workflowSource({
      issueNumber: 136,
      issueTitle: "Archive tar entry counting issue",
      issueBody: "Body",
      issueUrl: "https://github.com/AgentWorkforce/cloud/issues/136",
      archiveLeaseMaterializeEnabled: true,
    });
    const script = extractRawScript(source, "ARCHIVE_LEASE_MATERIALIZE_SCRIPT");
    const countTarEntries = buildArchiveTarEntryCounterForTest(script);

    expect(countTarEntries("root/\nroot/package.json\nroot/sst.config.ts\n")).toBe(3);
  });

  it("refuses to publish a repaired preflight stub checkout", () => {
    const source = workflowSource({
      issueNumber: 130,
      issueTitle: "Repair stub issue",
      issueBody: "Body",
      issueUrl: "https://github.com/AgentWorkforce/cloud/issues/130",
    });
    const script = extractRawScript(source, "CREATE_PROXY_PR_SCRIPT");

    expect(script).toContain("manual-preflight-app-path");
    expect(script).toContain("Refusing to publish from a repaired or invalid preflight checkout");
    expect(script).toContain("gitLines(['rev-list', '--max-parents=0', 'HEAD'])[0]");
    expect(script).toContain("baselineCommit + '..HEAD'");
    expect(script).toContain("gitLines(['ls-files', '--others', '--exclude-standard'])");
    expect(script).toContain("const artifactsRoot = '/project/.agent-relay/step-artifacts'");
    expect(script).toContain("path.join(artifactsRoot, artifactDir, repoName)");
    expect(script).toContain("name === 'implement' || name.startsWith('implement-repair-')");
    expect(script).not.toContain("name.startsWith('open-pr-repair-')");
    expect(script).toContain("restorePropagatedImplementationArtifacts()");
    expect(() => transformSync(script, { loader: "js", format: "cjs" })).not.toThrow();
  });

  it("counts materialized files for zero-file and populated working trees", async () => {
    const source = workflowSource({
      issueNumber: 129,
      issueTitle: "Count materialized files",
      issueBody: "Body",
      issueUrl: "https://github.com/AgentWorkforce/cloud/issues/129",
    });
    const script = extractRawScript(source, "ARCHIVE_LEASE_MATERIALIZE_SCRIPT");
    const countMaterializedFiles =
      buildCountMaterializedFilesForTest(script);
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloud-small-issue-materialize-"),
    );
    try {
      expect(await countMaterializedFiles(tempDir)).toBe(0);

      await fs.mkdir(path.join(tempDir, "packages/core/src"), {
        recursive: true,
      });
      await fs.mkdir(path.join(tempDir, ".github/workflows"), {
        recursive: true,
      });
      await fs.writeFile(path.join(tempDir, "README.md"), "readme");
      await fs.writeFile(
        path.join(tempDir, "packages/core/src/foo.ts"),
        "export {};",
      );
      await fs.writeFile(
        path.join(tempDir, ".github/workflows/ci.yml"),
        "name: ci",
      );

      expect(await countMaterializedFiles(tempDir)).toBe(3);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("writes multiline deterministic helper scripts to files before executing them", () => {
    const source = workflowSource({
      issueNumber: 125,
      issueTitle: "Multiline helper issue",
      issueBody: "Body",
      issueUrl: "https://github.com/AgentWorkforce/cloud/issues/125",
    });

    expect(source).not.toContain("node -e ' + JSON.stringify(MATERIALIZE_SCRIPT)");
    expect(source).not.toContain("node -e ' + JSON.stringify(CREATE_PROXY_PR_SCRIPT)");
    expect(source).toContain("Buffer.from(MATERIALIZE_SCRIPT, 'utf8').toString('base64')");
    expect(source).toContain("Buffer.from(CREATE_PROXY_PR_SCRIPT, 'utf8').toString('base64')");
    expect(source).toContain("base64 -d >");
    expect(source).toContain("/tmp/cloud-small-issue-materialize.cjs");
    expect(source).toContain("/tmp/cloud-small-issue-create-pr.cjs");
    expect(source).toContain("const [owner, repo, targetDir] = process.argv.slice(2);");
    expect(source).toContain("const [repoDir, owner, repo, branch, title, body] = process.argv.slice(2);");
    expect(() => transformSync(source, { loader: "ts", format: "esm" })).not.toThrow();
  });

  it("wraps both deterministic helper scripts in an async IIFE so top-level await is valid under .cjs execution", () => {
    const source = workflowSource({
      issueNumber: 126,
      issueTitle: "Top-level await helper issue",
      issueBody: "Body",
      issueUrl: "https://github.com/AgentWorkforce/cloud/issues/126",
    });

    // Helper scripts use top-level await AND CommonJS require(), and execute
    // as .cjs files where top-level await is illegal. Each body must be wrapped in
    // an async IIFE, or node throws "await is only valid in async functions" at
    // preflight (materialize) and open-pr (create-PR).
    for (const constName of [
      "LEGACY_MATERIALIZE_SCRIPT",
      "ARCHIVE_LEASE_MATERIALIZE_SCRIPT",
      "CREATE_PROXY_PR_SCRIPT",
    ]) {
      const script = extractRawScript(source, constName);
      expect(script.trimStart().startsWith("(async () => {")).toBe(true);
      expect(script).toContain("})().catch((error) => {");
      expect(() => transformSync(script, { loader: "js", format: "cjs" })).not.toThrow();
    }
  });

  it("emits a redacted resolver-exit diagnostic before failing on an empty diff", async () => {
    const source = workflowSource({
      issueNumber: 137,
      issueTitle: "Empty diff diagnostic issue",
      issueBody: "Body",
      issueUrl: "https://github.com/AgentWorkforce/cloud/issues/137",
    });
    const script = extractRawScript(source, "CREATE_PROXY_PR_SCRIPT");
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-small-issue-diag-"));
    const repoDir = path.join(tempDir, "cloud");
    const homeDir = path.join(tempDir, "home");
    const scriptPath = path.join(tempDir, "create-pr.cjs");
    try {
      await fs.mkdir(repoDir, { recursive: true });
      await fs.mkdir(path.join(homeDir, ".codex", "sessions", "2026"), { recursive: true });
      await fs.writeFile(path.join(scriptPath), script);
      await fs.writeFile(path.join(repoDir, "README.md"), "readme\n");
      runGit(repoDir, ["init"]);
      runGit(repoDir, ["config", "user.email", "test@example.com"]);
      runGit(repoDir, ["config", "user.name", "Test"]);
      runGit(repoDir, ["add", "-A"]);
      runGit(repoDir, ["commit", "-m", "baseline"]);
      await fs.writeFile(
        path.join(repoDir, ".relayfile-clone.json"),
        JSON.stringify({ headSha: "abc123" }),
      );
      await fs.writeFile(
        path.join(homeDir, "runner.log"),
        "runner started\nAuthorization: Bearer secret-token\nrunner ended\n",
      );
      await fs.writeFile(
        path.join(homeDir, ".codex", "sessions", "2026", "rollout-test.jsonl"),
        [
          JSON.stringify({ type: "assistant", message: "working" }),
          JSON.stringify({
            type: "error",
            message: "final failure with ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          }),
        ].join("\n"),
      );

      const result = spawnSync(process.execPath, [
        scriptPath,
        repoDir,
        "AgentWorkforce",
        "cloud",
        "codex/small-issue-137",
        "Fix small issue #137",
        "Fixes #137.",
      ], {
        cwd: tempDir,
        env: {
          ...process.env,
          HOME: homeDir,
          CLOUD_API_URL: "https://cloud.test",
          CLOUD_API_ACCESS_TOKEN: "cloud-token",
        },
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      const line = result.stdout
        .split("\n")
        .find((entry) => entry.startsWith("[resolver-exit-diagnostic] "));
      expect(line).toBeTruthy();
      const payload = JSON.parse(line!.slice("[resolver-exit-diagnostic] ".length));
      expect(payload).toMatchObject({
        diag: "cloud-small-issue-codex-resolver-exit",
        temporary: true,
        reason: "empty-diff-before-pr",
        issueNumber: "137",
        diffPaths: { changed: [".relayfile-clone.json"], deleted: [] },
      });
      expect(payload.gitStatusPorcelain).toContain(".relayfile-clone.json");
      expect(payload.gitDiffStat).toBe("");
      expect(payload.files.runnerLog.tail).toContain("runner started");
      expect(payload.files.runnerLog.tail).not.toContain("secret-token");
      expect(payload.files.rollouts[0].tail).toContain("final failure");
      expect(payload.files.rollouts[0].tail).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
      expect(result.stderr).toContain("No file changes to publish");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("cloud-small-issue-codex GitHub issue dispatch", () => {
  it("claims the issue before dispatching workflow side effects", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = createIssueCtx();

    await handleEvent(ctx, smallIssueEvent("issues.opened"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(
      "/v1/workspaces/workspace-1/fs/file?path=%2Fgithub%2F_agents%2Fcloud-small-issue-codex%2Fdispatch-claims%2Fissues%2FAgentWorkforce__cloud__1064.json",
    );
    expect(init).toEqual(expect.objectContaining({
      method: "PUT",
      headers: expect.objectContaining({
        authorization: "Bearer relayfile-token",
        "X-Correlation-Id": "cloud-small-issue-codex",
        "X-Relayfile-Write-Class": "foreground_control",
        "if-match": "0",
      }),
    }));
    expect(writeJsonCalls("slack", "post")).toHaveLength(1);
    expect(githubCommentBodies()).toContainEqual(expect.stringContaining("Workflow dispatch is starting"));
    expect(ctx.workflow.run).toHaveBeenCalledTimes(1);
    const workflowWrite = ctx.files.write.mock.calls.find(([path]) =>
      path === "workflows/cloud-small-issue-codex.ts"
    );
    expect(workflowWrite?.[1]).toContain("const BRANCH = 'codex/small-issue-' + ISSUE_NUMBER;");
    expect(workflowWrite?.[1]).not.toContain("Date.now() + ISSUE_NUMBER");
  });

  it("posts the claim comment exactly once when the dispatch claim is durably acquired (#1516 Bug 2)", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = createIssueCtx();

    await handleEvent(ctx, smallIssueEvent("issues.opened"));

    const claimComments = githubCommentBodies().filter((body) => body.includes("picked this up"));
    expect(claimComments).toHaveLength(1);
  });

  it("logs resolver-exit diagnostics for dispatch-claim and claim-comment outcomes", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = createIssueCtx();

    await handleEvent(ctx, smallIssueEvent("issues.opened"));

    expect(ctx.log).toHaveBeenCalledWith(
      "info",
      "resolver-exit diagnostic: dispatch-claim outcome",
      expect.objectContaining({
        diag: "cloud-small-issue-codex-resolver-exit",
        temporary: true,
        issueNumber: 1064,
        outcome: "acquired",
        status: 202,
        result: "acquired",
      }),
    );
    expect(ctx.log).toHaveBeenCalledWith(
      "info",
      "resolver-exit diagnostic: claim-comment outcome",
      expect.objectContaining({
        diag: "cloud-small-issue-codex-resolver-exit",
        temporary: true,
        issueNumber: 1064,
        outcome: "posted",
      }),
    );
  });

  it("does NOT post the claim comment when the dispatch claim fails open (degraded relayfile / #1516 Bug 2)", async () => {
    const fetchMock = vi.fn(async () => new Response("relayfile unavailable", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = createIssueCtx();

    await handleEvent(ctx, smallIssueEvent("issues.opened"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ctx.workflow.run).toHaveBeenCalledTimes(1);
    const claimComment = githubCommentBodies().find((body) => body.includes("picked this up"));
    expect(claimComment).toBeUndefined();
    expect(ctx.log).toHaveBeenCalledWith(
      "info",
      "resolver-exit diagnostic: dispatch-claim outcome",
      expect.objectContaining({
        outcome: "fail-open",
        status: 500,
        result: "server_error",
        bodyPreview: "relayfile unavailable",
      }),
    );
    expect(ctx.log).toHaveBeenCalledWith(
      "info",
      "resolver-exit diagnostic: claim-comment outcome",
      expect.objectContaining({ outcome: "skipped-fail-open" }),
    );
  });

  it("bounds a hung dispatch claim and skips side effects when durable claim state is unknown", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const ctx = createIssueCtx();

    const dispatch = handleEvent(ctx, smallIssueEvent("issues.opened"));
    await vi.runAllTimersAsync();
    await dispatch;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(ctx.slack.post).not.toHaveBeenCalled();
    expect(ctx.github.comment).not.toHaveBeenCalled();
    expect(ctx.workflow.run).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(
      "warn",
      "issue dispatch claim timed out; retrying",
      expect.objectContaining({
        issueNumber: 1064,
        attempt: 1,
        timeoutMs: 10000,
      }),
    );
    expect(ctx.log).toHaveBeenCalledWith(
      "error",
      "issue dispatch claim timed out; skipping dispatch",
      expect.objectContaining({
        issueNumber: 1064,
        attempt: 3,
        timeoutMs: 10000,
      }),
    );
    expect(ctx.log).toHaveBeenCalledWith(
      "info",
      "resolver-exit diagnostic: dispatch-claim outcome",
      expect.objectContaining({
        outcome: "claim-unavailable",
        result: "claim_timeout",
        attempts: 3,
        timeoutMs: 10000,
      }),
    );
  });

  it("does not fail open after a timed-out claim attempt leaves durable state unknown", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce((_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        })
      )
      .mockResolvedValue(
        new Response("write admission saturated", {
          status: 429,
          headers: { "Retry-After": "5" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const ctx = createIssueCtx();

    const dispatch = handleEvent(ctx, smallIssueEvent("issues.opened"));
    await vi.runAllTimersAsync();
    await dispatch;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(ctx.slack.post).not.toHaveBeenCalled();
    expect(ctx.github.comment).not.toHaveBeenCalled();
    expect(ctx.workflow.run).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(
      "error",
      "issue dispatch claim state unknown; skipping dispatch",
      expect.objectContaining({
        issueNumber: 1064,
        attempt: 3,
        status: 429,
        timeoutMs: 10000,
      }),
    );
    expect(ctx.log).toHaveBeenCalledWith(
      "info",
      "resolver-exit diagnostic: dispatch-claim outcome",
      expect.objectContaining({
        outcome: "claim-unavailable",
        result: "claim_state_unknown",
        attempts: 3,
        timeoutMs: 10000,
      }),
    );
  });

  it("reads the archive lease materialization kill switch from runtime persona inputs per dispatch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 202 })));
    const ctx = createIssueCtx();
    ctx.persona.inputs.CLOUD_SMALL_ISSUE_ARCHIVE_LEASE_MATERIALIZE_ENABLED = "yes";

    await handleEvent(ctx, smallIssueEvent("issues.opened"));

    const workflowWrite = ctx.files.write.mock.calls.find(([path]) =>
      path === "workflows/cloud-small-issue-codex.ts"
    );
    expect(workflowWrite?.[1]).toContain("const MATERIALIZE_SCRIPT = ARCHIVE_LEASE_MATERIALIZE_SCRIPT;");
  });

  it("claims with runtime credential env values and normalized url", async () => {
    process.env.RELAYFILE_URL = "https://relayfile-env.test///";
    process.env.RELAYFILE_WORKSPACE_ID = "env-workspace";
    const fetchMock = vi.fn(async () => new Response("{}", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = createIssueCtx();

    await handleEvent(ctx, smallIssueEvent("issues.opened"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("https://relayfile-env.test/v1/workspaces/env-workspace/fs/file");
    expect(String(url)).not.toContain("relayfile-env.test///v1");
    expect(init).toEqual(expect.objectContaining({
      headers: expect.objectContaining({
        authorization: "Bearer relayfile-token",
      }),
    }));
  });

  it("falls back to relayfile env values when ctx.credentials is absent in the deployed runner", async () => {
    process.env.RELAYFILE_URL = "https://relayfile-env.test///";
    process.env.RELAYFILE_WORKSPACE_ID = "env-workspace";
    const fetchMock = vi.fn(async () => new Response("{}", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = createIssueCtx();
    delete (ctx as any).credentials;

    await handleEvent(ctx, smallIssueEvent("issues.labeled"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("https://relayfile-env.test/v1/workspaces/env-workspace/fs/file");
    expect(init).toEqual(expect.objectContaining({
      headers: expect.objectContaining({
        authorization: "Bearer relayfile-token",
      }),
    }));
    expect(ctx.log).toHaveBeenCalledWith(
      "info",
      "resolver-exit diagnostic: dispatch-claim outcome",
      expect.objectContaining({
        outcome: "acquired",
        result: "acquired",
      }),
    );
    expect(ctx.workflow.run).toHaveBeenCalledTimes(1);
  });

  it("claims with typed ctx.credentials relayfile values when provided", async () => {
    delete process.env.RELAYFILE_URL;
    delete process.env.RELAYFILE_BASE_URL;
    delete process.env.RELAYFILE_TOKEN;
    delete process.env.RELAYFILE_WORKSPACE_ID;
    delete process.env.WORKFORCE_WORKSPACE_ID;
    delete process.env.RELAYFILE_WORKSPACE;
    delete process.env.RELAY_WORKSPACE_ID;
    const fetchMock = vi.fn(async () => new Response("{}", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = createIssueCtx();
    ctx.credentials = createCredentialsContext({
      relayfile: {
        url: "https://ctx-relayfile.test",
        token: "ctx-relayfile-token",
        workspaceId: "ctx-workspace",
      },
      cloudApi: {
        url: "https://ctx-cloud.test",
        token: "ctx-cloud-token",
      },
    });

    await handleEvent(ctx, smallIssueEvent("issues.opened"));

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("https://ctx-relayfile.test/v1/workspaces/ctx-workspace/fs/file");
    expect(init).toEqual(expect.objectContaining({
      headers: expect.objectContaining({
        authorization: "Bearer ctx-relayfile-token",
      }),
    }));
  });

  it("logs runtime credential accessor failures with explicit missing fields", async () => {
    delete process.env.CLOUD_API_URL;
    delete process.env.WORKFORCE_WORKSPACE_TOKEN;
    delete process.env.CLOUD_API_ACCESS_TOKEN;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 202 })));
    const ctx = createIssueCtx();

    await handleEvent(ctx, smallIssueEvent("issues.opened"));

    expect(ctx.log).toHaveBeenCalledWith(
      "error",
      "issue dispatch claim unavailable; proceeding fail-open",
      expect.objectContaining({
        issueNumber: 1064,
        error: "Runtime credentials are required: missing cloudApi.url, cloudApi.token",
      }),
    );
    expect(ctx.workflow.run).toHaveBeenCalledTimes(1);
  });

  it("skips all dispatch side effects when the issue claim already exists", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("conflict", { status: 409 })));
    const ctx = createIssueCtx();

    await handleEvent(ctx, smallIssueEvent("issues.labeled"));

    expect(ctx.slack.post).not.toHaveBeenCalled();
    expect(ctx.github.comment).not.toHaveBeenCalled();
    expect(ctx.workflow.run).not.toHaveBeenCalled();
    expect(ctx.files.write).not.toHaveBeenCalledWith(
      "workflows/cloud-small-issue-codex.ts",
      expect.any(String),
    );
    expect(ctx.log).toHaveBeenCalledWith(
      "info",
      "duplicate issue dispatch claim; skipping",
      expect.objectContaining({ issueNumber: 1064 }),
    );
  });

  it("releases the issue claim when workflow dispatch fails before a run is created", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 202 }))
      .mockResolvedValueOnce(new Response("{}", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = createIssueCtx();
    ctx.workflow.run.mockRejectedValueOnce(new Error("workflow api down"));

    await handleEvent(ctx, smallIssueEvent("issues.opened"));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [claimUrl, claimInit] = fetchMock.mock.calls[0];
    const [releaseUrl, releaseInit] = fetchMock.mock.calls[1];
    expect(String(releaseUrl)).toBe(String(claimUrl));
    expect(claimInit).toEqual(expect.objectContaining({ method: "PUT" }));
    expect(releaseInit).toEqual(expect.objectContaining({
      method: "DELETE",
      headers: expect.objectContaining({
        authorization: "Bearer relayfile-token",
        "X-Correlation-Id": "cloud-small-issue-codex",
        "if-match": "*",
      }),
    }));
    expect(writeJsonCalls("slack", "reply")).toContainEqual(expect.arrayContaining([
      expect.anything(),
      "slack",
      "reply",
      "/slack/channels/proj-cloud/messages/1710000000.000001/replies/draft-reply.json",
      { text: "Workflow dispatch failed for #1064: workflow api down" },
    ]));
    expect(githubCommentBodies()).toContain("Workflow dispatch failed: workflow api down");
  });

  it("comments terminal workflow failures when no pull request is opened", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 202 })));
    const ctx = createIssueCtx();
    ctx.workflow.run.mockResolvedValueOnce({
      runId: "run-1",
      completion: vi.fn(async () => ({
        status: "failed",
        output: "preflight failed: Timed out waiting for relayfile clone sentinel",
      })),
    });

    await handleEvent(ctx, smallIssueEvent("issues.opened"));

    expect(githubCommentBodies()).toContainEqual(
      expect.stringContaining("Workflow finished with status `failed` and did not open a PR."),
    );
    expect(githubCommentBodies()).toContainEqual(
      expect.stringContaining("Timed out waiting for relayfile clone sentinel"),
    );
  });

  it("does not claim opened issues until the small label predicate passes", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ctx = createIssueCtx();

    await handleEvent(ctx, smallIssueEvent("issues.opened", { labels: [] }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.slack.post).not.toHaveBeenCalled();
    expect(ctx.github.comment).not.toHaveBeenCalled();
    expect(ctx.workflow.run).not.toHaveBeenCalled();
  });

  it("does not claim closed issues even when they still have the small label", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ctx = createIssueCtx();

    await handleEvent(ctx, smallIssueEvent("issues.labeled", { state: "closed" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.slack.post).not.toHaveBeenCalled();
    expect(ctx.github.comment).not.toHaveBeenCalled();
    expect(ctx.workflow.run).not.toHaveBeenCalled();
    expect(ctx.files.write).not.toHaveBeenCalledWith(
      "workflows/cloud-small-issue-codex.ts",
      expect.any(String),
    );
    expect(ctx.log).toHaveBeenCalledWith(
      "info",
      "skipping non-open issue",
      expect.objectContaining({ issueState: "closed" }),
    );
  });

  it("fails open on claim infrastructure errors because integration-watch does not retry handler failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("relayfile down", { status: 503 })));
    const ctx = createIssueCtx();

    await handleEvent(ctx, smallIssueEvent("issues.opened"));

    expect(ctx.log).toHaveBeenCalledWith(
      "error",
      "issue dispatch claim failed; proceeding fail-open",
      expect.objectContaining({ issueNumber: 1064, status: 503 }),
    );
    expect(writeJsonCalls("slack", "post")).toHaveLength(1);
    expect(ctx.workflow.run).toHaveBeenCalledTimes(1);
  });

  it("logs write-admission fail-open details when dispatch claim admission is saturated", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: "workspace_busy",
              reason: "write_admission_limit",
            }),
            {
              status: 429,
              headers: { "Retry-After": "5" },
            },
          ),
      ),
    );
    const ctx = createIssueCtx();

    await handleEvent(ctx, smallIssueEvent("issues.opened"));

    expect(ctx.log).toHaveBeenCalledWith(
      "warn",
      "write_admission.fail_open",
      expect.objectContaining({
        issueNumber: 1064,
        status: 429,
        retryAfter: "5",
      }),
    );
    expect(writeJsonCalls("slack", "post")).toHaveLength(1);
    expect(ctx.workflow.run).toHaveBeenCalledTimes(1);
  });

  it("surfaces the local dry-run pull request URL as a terminal PR result", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 202 })));
    const ctx = createIssueCtx();
    ctx.workflow.run.mockResolvedValueOnce({
      runId: "run-1",
      completion: vi.fn(async () => ({
        status: "success",
        output: "http://localhost:3000/cloud/dev/github/pull-request/codex%2Fsmall-issue-1064",
      })),
    });

    await handleEvent(ctx, smallIssueEvent("issues.opened"));

    expect(githubCommentBodies()).toContain("Opened PR: http://localhost:3000/cloud/dev/github/pull-request/codex%2Fsmall-issue-1064");
    expect(writeJsonCalls("slack", "reply")).toContainEqual(expect.arrayContaining([
      expect.anything(),
      "slack",
      "reply",
      "/slack/channels/proj-cloud/messages/1710000000.000001/replies/draft-reply.json",
      { text: "Workflow completed for #1064: http://localhost:3000/cloud/dev/github/pull-request/codex%2Fsmall-issue-1064" },
    ]));
  });

  it("dispatches the workflow even when Slack VFS post rejects (slack failure must not kill the persona)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 202 })));
    const ctx = createIssueCtx();
    runtimeMocks.writeJsonFile.mockRejectedValueOnce(new Error("Slack proxy: 401 unauthorized"));

    await handleEvent(ctx, smallIssueEvent("issues.opened"));

    // First call (in the try block) rejects; subsequent success-path Slack handoff still attempted.
    expect(ctx.log).toHaveBeenCalledWith(
      "warn",
      "slack VFS post failed; continuing without slack handoff",
      expect.objectContaining({ channel: "proj-cloud", error: expect.stringContaining("Slack proxy") }),
    );
    // Critical: workflow dispatch + claim comment still happen even with slack degraded.
    expect(ctx.workflow.run).toHaveBeenCalledTimes(1);
    expect(githubCommentBodies()).toContainEqual(expect.stringContaining("Workflow dispatch is starting"));
  });

  it("survives Slack VFS reply rejection in the error path without unhandled rejection", async () => {
    vi.stubGlobal("fetch", vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 202 }))
      .mockResolvedValueOnce(new Response("{}", { status: 202 })));
    const ctx = createIssueCtx();
    ctx.workflow.run.mockRejectedValueOnce(new Error("workflow api down"));
    runtimeMocks.writeJsonFile.mockImplementation(async (_client, provider, operation, relayPath) => {
      if (provider === "slack" && operation === "reply") {
        throw new Error("Slack proxy: 401 unauthorized");
      }
      return {
        path: relayPath,
        absolutePath: `/tmp/relayfile${relayPath}`,
        receipt: { created: "1710000000.000001" },
      };
    });

    await expect(handleEvent(ctx, smallIssueEvent("issues.opened"))).resolves.toBeUndefined();

    expect(ctx.log).toHaveBeenCalledWith(
      "warn",
      "slack VFS reply failed; continuing",
      expect.objectContaining({ channel: "proj-cloud", threadTs: "1710000000.000001" }),
    );
    // The catch handler's commentIssue still runs after the slack.reply failure.
    expect(githubCommentBodies()).toContain("Workflow dispatch failed: workflow api down");
  });

  it("survives Slack VFS post rejection when slack binding is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 202 })));
    const ctx = createIssueCtx();
    // Production runtime no longer provides ctx.slack.post; Slack announces go through VFS.
    ctx.slack.post = undefined as any;
    runtimeMocks.writeJsonFile.mockRejectedValueOnce(new Error("relayfile: 403 forbidden"));

    await handleEvent(ctx, smallIssueEvent("issues.opened"));

    expect(ctx.log).toHaveBeenCalledWith(
      "warn",
      "slack VFS post failed; continuing without slack handoff",
      expect.objectContaining({ channel: "proj-cloud", error: expect.stringContaining("relayfile") }),
    );
    expect(ctx.workflow.run).toHaveBeenCalledTimes(1);
  });

  it("does not hang forever when the Slack VFS write wedges (e.g. a stuck FUSE mount)", async () => {
    // Regression pin: writeJsonFile's own `writebackTimeoutMs` only bounds the
    // post-write receipt-poll — it can't help if the underlying relayfile mount
    // never resolves the write at all. The persona must apply its own hard
    // wall-clock ceiling so a wedged Slack write can't stall the claim
    // comment + PR behind it.
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 202 })));
    const ctx = createIssueCtx();
    runtimeMocks.writeJsonFile.mockImplementation(async (_client: unknown, provider: string, operation: string) => {
      if (provider === "slack" && operation === "post") {
        return new Promise(() => {}); // never resolves
      }
      return {
        path: "/dev/null",
        absolutePath: "/tmp/relayfile/dev/null",
        receipt: { created: "1710000000.000001" },
      };
    });

    const dispatch = handleEvent(ctx, smallIssueEvent("issues.opened"));
    await vi.runAllTimersAsync();
    await dispatch;

    expect(ctx.log).toHaveBeenCalledWith(
      "warn",
      "slack VFS post failed; continuing without slack handoff",
      expect.objectContaining({ channel: "proj-cloud", error: expect.stringContaining("did not settle within") }),
    );
    // The claim comment + workflow dispatch still happen despite the wedged Slack write.
    expect(ctx.workflow.run).toHaveBeenCalledTimes(1);
    expect(githubCommentBodies()).toContainEqual(expect.stringContaining("picked this up"));
  });

  it("warns instead of silently no-op'ing when GitHub VFS comments fail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 202 })));
    const ctx = createIssueCtx();
    runtimeMocks.writeJsonFile.mockImplementation(async (_client, provider, operation, relayPath) => {
      if (provider === "github" && operation === "comment") {
        throw new Error("relayfile: 403 forbidden");
      }
      return {
        path: relayPath,
        absolutePath: `/tmp/relayfile${relayPath}`,
        receipt: { created: "1710000000.000001" },
      };
    });
    ctx.github = undefined as any;

    await handleEvent(ctx, smallIssueEvent("issues.opened"));

    // The "claimed" comment attempt fires the warn.
    expect(ctx.log).toHaveBeenCalledWith(
      "warn",
      "github VFS comment failed; comment dropped",
      expect.objectContaining({ issueNumber: 1064 }),
    );
    // Persona still dispatches the workflow even though github comments cannot land.
    expect(ctx.workflow.run).toHaveBeenCalledTimes(1);
  });
});

describe("cloud-small-issue-codex defers to the complex workflow", () => {
  it("skips an issue labeled both `small` and `complex` so it does not double-PR", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 202 })));
    const ctx = createIssueCtx();

    await handleEvent(
      ctx,
      smallIssueEvent("issues.labeled", { labels: [{ name: "small" }, { name: "complex" }] }),
    );

    expect(ctx.workflow.run).not.toHaveBeenCalled();
    expect(ctx.slack.post).not.toHaveBeenCalled();
    expect(ctx.github.comment).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(
      "info",
      "skipping issue claimed by complex workflow",
      expect.objectContaining({ labels: ["small", "complex"] }),
    );
  });
});

describe("cloud-small-issue-codex v4 runtime event contract", () => {
  it("ignores a pre-v4 event shape instead of misreading it as a github event", async () => {
    // Regression pin for the v4 runtime migration: `envelopeToAgentEvent`
    // (runtime >=4.0) never sets `event.source`/`event.payload` (the removed
    // `shimEnvelope` shape) — the provider lives at `event.resource.provider`
    // and the payload is loaded via `await event.expand("full")`. A stray
    // pre-v4-shaped event must be rejected as unsupported, not silently
    // treated as a github issue event.
    const ctx = createIssueCtx();

    await handleEvent(ctx, {
      id: "evt-pre-v4",
      source: "github",
      type: "issues.labeled",
      payload: {
        repository: { full_name: "AgentWorkforce/cloud" },
        issue: { number: 1, title: "x", body: "y", labels: [{ name: "small" }], state: "open" },
      },
    });

    expect(ctx.workflow.run).not.toHaveBeenCalled();
    expect(ctx.slack.post).not.toHaveBeenCalled();
    expect(ctx.github.comment).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(
      "info",
      "ignoring unsupported event source",
      expect.objectContaining({ provider: undefined, type: "issues.labeled" }),
    );
  });

  it("claims a properly-shaped v4 github.issues.labeled event", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 202 })));
    const ctx = createIssueCtx();

    await handleEvent(ctx, smallIssueEvent("issues.labeled"));

    expect(ctx.log).not.toHaveBeenCalledWith(
      "info",
      "ignoring unsupported event source",
      expect.anything(),
    );
    expect(ctx.workflow.run).toHaveBeenCalled();
  });
});

function createIssueCtx() {
  return {
    workspaceId: "workspace-1",
    agent: { id: "agent-1" },
    persona: { inputs: { SLACK_CHANNEL: "proj-cloud" } },
    log: vi.fn(),
    sandbox: { cwd: "/tmp/workspace" },
    files: {
      read: vi.fn(),
      write: vi.fn(),
    },
    slack: {
      post: vi.fn(async () => ({ channel: "proj-cloud", ts: "1710000000.000001" })),
      reply: vi.fn(),
    },
    github: {
      comment: vi.fn(),
    },
    workflow: {
      run: vi.fn(async () => ({
        runId: "run-1",
        completion: vi.fn(async () => ({
          status: "success",
          output: "Opened https://github.com/AgentWorkforce/cloud/pull/123 on codex/small-issue-1064",
        })),
      })),
    },
    credentials: createCredentialsContext(),
  };
}

function writeJsonCalls(provider?: string, operation?: string) {
  return runtimeMocks.writeJsonFile.mock.calls.filter(([, callProvider, callOperation]) =>
    (provider === undefined || callProvider === provider) &&
    (operation === undefined || callOperation === operation)
  );
}

function githubCommentBodies(): string[] {
  return writeJsonCalls("github", "comment")
    .map(([, , , , payload]) => (payload as { body?: unknown }).body)
    .filter((body): body is string => typeof body === "string");
}

function expectWriteJsonPathsMatchWritebackAllowlist() {
  for (const [, provider, operation, relayPath, payload] of runtimeMocks.writeJsonFile.mock.calls) {
    const key = `${String(provider)}:${String(operation)}`;
    const body = payload as Record<string, unknown>;
    if (key === "slack:post") {
      const path = String(relayPath);
      expect(SLACK_UPSERT_WRITEBACK_PATH.test(path)).toBe(true);
      expect(SLACK_UPSERT_WRITEBACK_PATH.test(path.replace("/messages/", "/message/"))).toBe(false);
      expect(body.text).toEqual(expect.any(String));
      expect(body.body).toBeUndefined();
    } else if (key === "slack:reply") {
      const path = String(relayPath);
      expect(SLACK_UPSERT_WRITEBACK_PATH.test(path)).toBe(true);
      expect(SLACK_UPSERT_WRITEBACK_PATH.test(path.replace("/replies/", "/reply/"))).toBe(false);
      expect(body.text).toEqual(expect.any(String));
      expect(body.body).toBeUndefined();
    } else if (key === "github:comment") {
      const path = String(relayPath);
      expect(GITHUB_UPSERT_WRITEBACK_PATH.test(path)).toBe(true);
      expect(GITHUB_UPSERT_WRITEBACK_PATH.test(path.replace("/comments/", "/comment/"))).toBe(false);
      expect(body.body).toEqual(expect.any(String));
      expect(body.text).toBeUndefined();
    } else {
      throw new Error(`unexpected writeJsonFile call ${key} ${String(relayPath)}`);
    }
  }
}

function createCredentialsContext(overrides: any = {}) {
  const readUrl = (value: string | undefined) => value?.replace(/\/+$/u, "") || undefined;
  const relayfile = overrides.relayfile ?? {
    url: readUrl(process.env.RELAYFILE_URL),
    token: process.env.RELAYFILE_TOKEN,
    workspaceId: process.env.RELAYFILE_WORKSPACE_ID,
  };
  const cloudApi = overrides.cloudApi ?? {
    url: readUrl(process.env.CLOUD_API_URL),
    token: process.env.CLOUD_API_ACCESS_TOKEN,
  };
  const missing = [
    ...(!relayfile.url ? ["relayfile.url"] : []),
    ...(!relayfile.token ? ["relayfile.token"] : []),
    ...(!relayfile.workspaceId ? ["relayfile.workspaceId"] : []),
    ...(!cloudApi.url ? ["cloudApi.url"] : []),
    ...(!cloudApi.token ? ["cloudApi.token"] : []),
  ];
  const required = () => {
    if (missing.length > 0) {
      throw new Error(`Runtime credentials are required: missing ${missing.join(", ")}`);
    }
    return { relayfile, cloudApi };
  };
  return {
    get relayfile() {
      return required().relayfile;
    },
    get cloudApi() {
      return required().cloudApi;
    },
    tryRequire() {
      return missing.length > 0 ? null : { relayfile, cloudApi };
    },
    require: required,
  };
}

function smallIssueEvent(type: "issues.opened" | "issues.labeled", options: {
  labels?: Array<string | { name: string }>;
  state?: string;
} = {}) {
  const labels = options.labels ?? [{ name: "small" }];
  const id = `evt-${type}`;
  const payload = {
    repository: { full_name: "AgentWorkforce/cloud" },
    issue: {
      number: 1064,
      title: "Fix the thing",
      body: "Issue body",
      html_url: "https://github.com/AgentWorkforce/cloud/issues/1064",
      labels,
      state: options.state ?? "open",
    },
  };
  const path = "/github/repos/AgentWorkforce/cloud/issues/1064";
  return {
    id,
    type: `github.${type}`,
    resource: { path, kind: "github.issues", id, provider: "github" },
    expand: async () => ({ level: "full", path, data: payload }),
  };
}

function extractRawScript(source: string, constName: string): string {
  const marker = `const ${constName} = String.raw\``;
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const bodyStart = start + marker.length;
  const end = source.indexOf("\`;", bodyStart);
  expect(end).toBeGreaterThan(bodyStart);
  return source.slice(bodyStart, end);
}

function extractSandboxCredentialHelper(script: string): string {
  const start = script.indexOf("function requireRuntimeCredentials");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = script.indexOf("const cloneInfo", start);
  const fallbackEnd = script.indexOf("const repoRoot", start);
  const helperEnd = end >= 0 ? end : fallbackEnd;
  expect(helperEnd).toBeGreaterThan(start);
  return script.slice(start, helperEnd);
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

function buildCountMaterializedFilesForTest(
  script: string,
): (dir: string) => Promise<number> {
  const match = script.match(
    /async function countMaterializedFiles\(dir\) \{[\s\S]*?\n\}/,
  );
  expect(match?.[0]).toBeTruthy();
  return new Function(
    "fs",
    "path",
    `${match![0]}; return countMaterializedFiles;`,
  )(fs, path) as (dir: string) => Promise<number>;
}

function buildArchiveTarEntryCounterForTest(script: string): (tarOutput: string) => number {
  const match = script.match(
    /const tarEntries = execFileSync\('tar', \['-tzf', tarPath\], \{ encoding: 'utf8' \}\)\n\s+\.split\('[\s\S]*?'\)\n\s+\.filter\(Boolean\)\n\s+\.length;/,
  );
  expect(match?.[0]).toBeTruthy();
  return new Function(
    "tarOutput",
    "const tarPath = '/tmp/archive.tar.gz';\n" +
      "const execFileSync = () => tarOutput;\n" +
      `${match![0]}\n` +
      "return tarEntries;",
  ) as (tarOutput: string) => number;
}
