import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GITHUB_UPSERT_WRITEBACK_PATH,
  SLACK_UPSERT_WRITEBACK_PATH,
} from "../../packages/relayfile/src/writeback/path-eligibility";
import { transformSync } from "esbuild";
import {
  claimIssueDispatch as claimIssueDispatchShared,
  type IssueDispatchClaimConfig,
} from "../_shared/issue-resolver";

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
const { workflowSource } = agentModule;

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

describe("cloud-complex-issue-workflow agent declaration", () => {
  it("declares GitHub and Slack deploy triggers in the top-level agent block", () => {
    expect(agentExport).toMatchObject({
      triggers: EXPECTED_AGENT_TRIGGERS,
    });
  });
});

describe("cloud-complex-issue-workflow dispatch routing (label == complex)", () => {
  it("dispatches the multi-stage workflow only for issues labeled `complex`", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 202 })));
    const ctx = createIssueCtx();

    await handleEvent(ctx, complexIssueEvent("issues.opened"));

    expect(ctx.workflow.run).toHaveBeenCalledTimes(1);
    expect(ctx.workflow.run).toHaveBeenCalledWith(
      "cloud-complex-issue-workflow",
      expect.objectContaining({ issueNumber: 2048 }),
    );
    // It writes the multi-stage workflow source, not the small-issue workflow.
    expect(ctx.files.write).toHaveBeenCalledWith(
      "workflows/cloud-complex-issue-workflow.ts",
      expect.any(String),
    );
  });

  it("posts the claim comment exactly once when the dispatch claim is durably acquired (#1516 Bug 2)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 202 })));
    const ctx = createIssueCtx();

    await handleEvent(ctx, complexIssueEvent("issues.opened"));

    const claimComments = githubCommentBodies().filter((body) => body.includes("picked this up"));
    expect(claimComments).toHaveLength(1);
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

    const dispatch = handleEvent(ctx, complexIssueEvent("issues.opened"));
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

  it("does NOT post the claim comment when the dispatch claim fails open (degraded relayfile / #1516 Bug 2)", async () => {
    const fetchMock = vi.fn(async () => new Response("relayfile unavailable", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = createIssueCtx();

    await handleEvent(ctx, complexIssueEvent("issues.opened"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ctx.workflow.run).toHaveBeenCalledTimes(1);
    const claimComment = githubCommentBodies().find((body) => body.includes("picked this up"));
    expect(claimComment).toBeUndefined();
  });

  it("falls back to relayfile env values when ctx.credentials is absent in the deployed runner", async () => {
    process.env.RELAYFILE_URL = "https://relayfile-env.test///";
    process.env.RELAYFILE_WORKSPACE_ID = "env-workspace";
    const fetchMock = vi.fn(async () => new Response("{}", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = createIssueCtxWithoutCredentials();

    await handleEvent(ctx, complexIssueEvent("issues.labeled"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("https://relayfile-env.test/v1/workspaces/env-workspace/fs/file");
    expect(init).toEqual(expect.objectContaining({
      headers: expect.objectContaining({
        authorization: "Bearer relayfile-token",
      }),
    }));
    expect(ctx.workflow.run).toHaveBeenCalledTimes(1);
  });

  it("skips issues that do not carry the `complex` label (e.g. `small`)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 202 })));
    const ctx = createIssueCtx();

    await handleEvent(ctx, complexIssueEvent("issues.labeled", { labels: [{ name: "small" }] }));

    expect(ctx.workflow.run).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(
      "info",
      "skipping issue without complex label",
      expect.objectContaining({ labels: ["small"] }),
    );
  });

  it("ignores events for other repositories", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 202 })));
    const ctx = createIssueCtx();

    await handleEvent(ctx, {
      id: "evt-other-repo",
      type: "github.issues.opened",
      resource: {
        path: "/github/repos/AgentWorkforce/other/issues/7",
        kind: "github.issues",
        id: "evt-other-repo",
        provider: "github",
      },
      expand: async () => ({
        level: "full",
        path: "/github/repos/AgentWorkforce/other/issues/7",
        data: {
          repository: { full_name: "AgentWorkforce/other" },
          issue: { number: 7, title: "x", body: "y", labels: [{ name: "complex" }], state: "open" },
        },
      }),
    });

    expect(ctx.workflow.run).not.toHaveBeenCalled();
  });

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
        issue: { number: 1, title: "x", body: "y", labels: [{ name: "complex" }], state: "open" },
      },
    });

    expect(ctx.workflow.run).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(
      "info",
      "ignoring unsupported event source",
      expect.objectContaining({ provider: undefined, type: "issues.labeled" }),
    );
  });

  it("skips all side effects when the dispatch claim already exists (409)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("conflict", { status: 409 })));
    const ctx = createIssueCtx();

    await handleEvent(ctx, complexIssueEvent("issues.labeled"));

    expect(ctx.slack.post).not.toHaveBeenCalled();
    expect(ctx.github.comment).not.toHaveBeenCalled();
    expect(runtimeMocks.writeJsonFile).not.toHaveBeenCalled();
    expect(ctx.workflow.run).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(
      "info",
      "duplicate issue dispatch claim; skipping",
      expect.objectContaining({ issueNumber: 2048 }),
    );
  });
});

describe("issue dispatch legacy credential guard", () => {
  it("fails open instead of crashing when single-attempt legacy ctx credentials are absent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ctx = createIssueCtxWithoutCredentials();

    const claim = await claimIssueDispatchShared(
      ctx,
      {
        eventId: "evt-legacy-single",
        issueNumber: 2048,
        issueTitle: "Refactor the widget pipeline",
      },
      legacyClaimConfig({ claimPutPolicy: { kind: "single-attempt" } }),
    );

    expect(claim).toEqual({ proceed: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(
      "error",
      "issue dispatch claim unavailable; proceeding fail-open",
      expect.objectContaining({
        issueNumber: 2048,
        error: expect.stringContaining("missing ctx.credentials"),
      }),
    );
  });

  it("fails open instead of crashing when bounded-timeout legacy ctx credentials are absent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ctx = createIssueCtxWithoutCredentials();

    const claim = await claimIssueDispatchShared(
      ctx,
      {
        eventId: "evt-legacy-bounded",
        issueNumber: 2048,
        issueTitle: "Refactor the widget pipeline",
      },
      legacyClaimConfig({
        claimPutPolicy: {
          kind: "bounded-timeout",
          maxAttempts: 3,
          timeoutMs: 10_000,
          backoffMs: 500,
        },
      }),
    );

    expect(claim).toEqual({
      proceed: true,
      diagnostic: {
        result: "credentials_unavailable",
        error: expect.stringContaining("missing ctx.credentials"),
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(
      "error",
      "issue dispatch claim unavailable; proceeding fail-open",
      expect.objectContaining({
        issueNumber: 2048,
        error: expect.stringContaining("missing ctx.credentials"),
      }),
    );
  });

  it("reports the runtime credential error when bounded-timeout legacy ctx credentials are incomplete", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ctx = createIssueCtx();
    ctx.credentials = createCredentialsContext({
      relayfile: {
        url: "",
        token: process.env.RELAYFILE_TOKEN,
        workspaceId: process.env.RELAYFILE_WORKSPACE_ID,
      },
    });

    const claim = await claimIssueDispatchShared(
      ctx,
      {
        eventId: "evt-legacy-incomplete",
        issueNumber: 2048,
        issueTitle: "Refactor the widget pipeline",
      },
      legacyClaimConfig({
        claimPutPolicy: {
          kind: "bounded-timeout",
          maxAttempts: 3,
          timeoutMs: 10_000,
          backoffMs: 500,
        },
      }),
    );

    expect(claim).toEqual({
      proceed: true,
      diagnostic: {
        result: "credentials_unavailable",
        error: expect.stringContaining("missing relayfile.url"),
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(
      "error",
      "issue dispatch claim unavailable; proceeding fail-open",
      expect.objectContaining({
        issueNumber: 2048,
        error: expect.stringContaining("missing relayfile.url"),
      }),
    );
  });
});

describe("cloud-complex-issue-workflow slack follow-up channel filter", () => {
  function slackMessageEvent(channel: string) {
    const path = `/relaycast/${channel}/messages/evt-slack-1`;
    return {
      id: "evt-slack-1",
      type: "relaycast.message",
      channel,
      resource: { path, kind: "relaycast.message", id: "evt-slack-1", provider: "relaycast" },
      expand: async () => ({
        level: "full",
        path,
        data: {
          channel,
          text: "How is the PR going?",
          ts: "1710000100.000002",
          thread_ts: "1710000000.000001",
        },
      }),
    };
  }

  it("ignores a follow-up posted to a channel other than the configured one", async () => {
    const ctx = createIssueCtx();
    ctx.files.read = vi.fn(async () => null);
    ctx.harness = { run: vi.fn() };

    await handleEvent(ctx, slackMessageEvent("some-other-channel"));

    // Filtered at the channel guard before any marker read/write or harness run.
    expect(ctx.files.read).not.toHaveBeenCalled();
    expect(ctx.files.write).not.toHaveBeenCalled();
    expect(ctx.harness.run).not.toHaveBeenCalled();
  });

  it("processes a follow-up on the configured channel (reads the dedup marker)", async () => {
    const ctx = createIssueCtx();
    // marker absent -> proceeds; thread state absent -> returns before harness run,
    // but only AFTER passing the channel filter and checking the marker.
    ctx.files.read = vi.fn(async () => null);
    ctx.harness = { run: vi.fn() };

    await handleEvent(ctx, slackMessageEvent("proj-cloud"));

    expect(ctx.files.read).toHaveBeenCalled();
  });

  it("honors a custom configured channel via persona input", async () => {
    const ctx = createIssueCtx();
    ctx.persona = { inputs: { SLACK_CHANNEL: "team-secret" } };
    ctx.files.read = vi.fn(async () => null);
    ctx.harness = { run: vi.fn() };

    // proj-cloud is no longer the configured channel -> ignored.
    await handleEvent(ctx, slackMessageEvent("proj-cloud"));
    expect(ctx.files.read).not.toHaveBeenCalled();

    // the configured custom channel is listened on.
    await handleEvent(ctx, slackMessageEvent("team-secret"));
    expect(ctx.files.read).toHaveBeenCalled();
  });
});

describe("cloud-complex-issue-workflow multi-agent workflow source", () => {
  const source = () =>
    workflowSource({
      issueNumber: 2048,
      issueTitle: "Refactor the widget pipeline",
      issueBody: "Touches multiple files; needs a plan.",
      issueUrl: "https://github.com/AgentWorkforce/cloud/issues/2048",
    });

  it("emits valid TypeScript", () => {
    expect(() => transformSync(source(), { loader: "ts", format: "esm" })).not.toThrow();
  });

  it("declares three distinct agents: planner (claude), impl (codex), reviewer (claude)", () => {
    const text = source();
    expect(text).toContain(".agent('planner', { cli: 'claude'");
    expect(text).toContain(".agent('impl', { cli: 'codex'");
    expect(text).toContain(".agent('reviewer', { cli: 'claude'");
  });

  it("chains four distinct stages plan -> implement -> review -> open-pr (plus a bounded repair pass)", () => {
    const text = source();
    expect(text).toContain(".step('preflight', {");
    expect(text).toContain(".step('plan', {");
    expect(text).toContain(".step('implement', {");
    expect(text).toContain(".step('review', {");
    expect(text).toContain(".step('implement-repair', {");
    expect(text).toContain(".step('open-pr', {");

    // Dependency chain is strictly ordered.
    expect(stepDependsOn(text, "plan")).toEqual(["preflight"]);
    expect(stepDependsOn(text, "implement")).toEqual(["plan"]);
    expect(stepDependsOn(text, "review")).toEqual(["implement"]);
    expect(stepDependsOn(text, "implement-repair")).toEqual(["review"]);
    expect(stepDependsOn(text, "open-pr")).toEqual(["implement-repair"]);
  });

  it("assigns each agent step to its agent and keeps stages on the shared working tree", () => {
    const text = source();
    expect(stepField(text, "plan", "agent")).toBe("planner");
    expect(stepField(text, "implement", "agent")).toBe("impl");
    expect(stepField(text, "review", "agent")).toBe("reviewer");
    expect(stepField(text, "implement-repair", "agent")).toBe("impl");
    expect(text).toContain("const REPO_DIR = './cloud';");
    expect(text).toContain("const BRANCH = 'codex/complex-issue-' + ISSUE_NUMBER;");
  });

  it("instructs the plan stage to write PLAN.md and the review stage to write a VERDICT to REVIEW.md", () => {
    const text = source();
    expect(text).toContain("/PLAN.md");
    expect(text).toContain("/REVIEW.md");
    expect(text).toContain("VERDICT: APPROVE");
    expect(text).toContain("VERDICT: REQUEST_CHANGES");
  });

  it("opens the PR through the Cloud proxy (no sandbox GitHub tokens, no git push)", () => {
    const text = source();
    expect(text).not.toContain("GITHUB_TOKEN");
    expect(text).not.toContain("https://api.github.com");
    expect(text).not.toContain("git push");
    expect(text).toContain("/api/v1/github/clone/request");
    expect(text).toContain("/api/v1/github/pull-request");
  });

  it("open-pr embeds the plan + review verdict in the PR body and excludes PLAN/REVIEW from the code diff", () => {
    const createPr = extractRawScript(source(), "CREATE_PROXY_PR_SCRIPT");
    // Reads the stage artifacts for the body.
    expect(createPr).toContain("readStageMetaFile('PLAN.md')");
    expect(createPr).toContain("readStageMetaFile('REVIEW.md')");
    // First line of the review is surfaced as the verdict.
    expect(createPr).toContain("const reviewVerdict = (reviewText.split('\\n')[0] || '').trim();");
    // PLAN.md / REVIEW.md are excluded from the published file set.
    expect(createPr).toContain("if (filePath === 'PLAN.md' || filePath === 'REVIEW.md') continue;");
    // The augmented body is what gets posted (not the raw argv body).
    expect(createPr).toContain("const prBody = prBodySections.join");
    expect(createPr).toContain("title, body: prBody, files }");
  });

  it("restores plan/implement/review stage artifacts when the working tree was reset", () => {
    const createPr = extractRawScript(source(), "CREATE_PROXY_PR_SCRIPT");
    expect(createPr).toContain(
      "name === 'plan' || name === 'implement' || name === 'review' || name.startsWith('implement-repair-')",
    );
  });

  it("emits decodable, syntactically valid sandbox node scripts (escaping survives)", () => {
    const text = source();
    for (const name of [
      "LEGACY_MATERIALIZE_SCRIPT",
      "ARCHIVE_LEASE_MATERIALIZE_SCRIPT",
      "CREATE_PROXY_PR_SCRIPT",
    ]) {
      const script = extractRawScript(text, name);
      expect(() => transformSync(script, { loader: "js", format: "cjs" })).not.toThrow();
    }
  });
});

function createIssueCtx() {
  return {
    workspaceId: "workspace-1",
    agent: { id: "agent-complex-1" },
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
        runId: "run-complex-1",
        completion: vi.fn(async () => ({
          status: "success",
          output: "Opened https://github.com/AgentWorkforce/cloud/pull/321 on codex/complex-issue-2048",
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

function createIssueCtxWithoutCredentials() {
  const ctx = createIssueCtx();
  delete (ctx as any).credentials;
  return ctx;
}

function legacyClaimConfig(
  overrides: Pick<IssueDispatchClaimConfig, "claimPutPolicy">,
): IssueDispatchClaimConfig {
  return {
    repoOwner: "AgentWorkforce",
    repoName: "cloud",
    repoFullName: "AgentWorkforce/cloud",
    claimRoot: "/github/_agents/cloud-complex-issue-workflow/dispatch-claims",
    correlationId: "cloud-complex-issue-workflow",
    agentIdFallback: "cloud-complex-issue-workflow",
    credentialSource: "legacy-ctx-direct",
    claimPutPolicy: overrides.claimPutPolicy,
    unknownStatePolicy: overrides.claimPutPolicy.kind === "bounded-timeout" ? "fail-closed" : "none",
    degradedHttpPolicy: "fail-open",
    diagnostics: overrides.claimPutPolicy.kind === "bounded-timeout" ? "include" : "omit",
  };
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

function complexIssueEvent(
  type: "issues.opened" | "issues.labeled",
  options: { labels?: Array<string | { name: string }>; state?: string } = {},
) {
  const labels = options.labels ?? [{ name: "complex" }];
  const id = `evt-${type}`;
  const payload = {
    repository: { full_name: "AgentWorkforce/cloud" },
    issue: {
      number: 2048,
      title: "Refactor the widget pipeline",
      body: "Touches multiple files; needs a plan.",
      html_url: "https://github.com/AgentWorkforce/cloud/issues/2048",
      labels,
      state: options.state ?? "open",
    },
  };
  const path = "/github/repos/AgentWorkforce/cloud/issues/2048";
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

// Returns the `dependsOn` array literal for a named step in the workflow source.
function stepDependsOn(source: string, stepName: string): string[] {
  const block = stepBlock(source, stepName);
  const match = block.match(/dependsOn:\s*\[([^\]]*)\]/);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function stepField(source: string, stepName: string, field: string): string | null {
  const block = stepBlock(source, stepName);
  const match = block.match(new RegExp(`${field}:\\s*'([^']*)'`));
  return match ? match[1] : null;
}

// Slices the source from `.step('<name>', {` to the next `.step(` / `.run(`.
function stepBlock(source: string, stepName: string): string {
  const start = source.indexOf(`.step('${stepName}', {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start + 1);
  const nextStep = rest.indexOf(".step('");
  const nextRun = rest.indexOf(".run(");
  const candidates = [nextStep, nextRun].filter((index) => index >= 0);
  const end = candidates.length > 0 ? Math.min(...candidates) : rest.length;
  return rest.slice(0, end);
}
