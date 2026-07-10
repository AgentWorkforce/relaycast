import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveHostedProviderEnvironmentMock = vi.fn();
const writeDeploymentRecordMock = vi.fn();
const resolveServerDaytonaAuthParamsMock = vi.fn();
const resolveAgentGatewayBaseUrlMock = vi.fn();

const uploadedFiles = new Map<string, string>();
const executedCommands: string[] = [];
let createCall: Record<string, unknown> | null = null;

vi.mock("@daytonaio/sdk", () => ({
  Daytona: class FakeDaytona {
    constructor(_auth: unknown) {}

    async create(input: Record<string, unknown>) {
      createCall = input;
      return {
        id: "sandbox_hosted_1",
        fs: {
          uploadFile: vi.fn(async (content: Buffer, remotePath: string) => {
            uploadedFiles.set(remotePath, Buffer.from(content).toString("utf8"));
          }),
        },
        process: {
          executeCommand: vi.fn(async (command: string) => {
            executedCommands.push(command);
            return { result: "" };
          }),
        },
      };
    }
  },
}));

vi.mock("@/lib/daytona-auth", () => ({
  resolveServerDaytonaAuthParams: (...args: unknown[]) =>
    resolveServerDaytonaAuthParamsMock(...args),
}));

vi.mock("@cloud/core/config/snapshot.js", () => ({
  getSnapshotName: vi.fn(async () => "snapshot-test"),
}));

vi.mock("@/lib/proactive-runtime/dashboard", () => ({
  resolveAgentGatewayBaseUrl: (...args: unknown[]) =>
    resolveAgentGatewayBaseUrlMock(...args),
}));

vi.mock("@/lib/proactive-runtime/deploy-store", () => ({
  deleteDeploymentRecord: vi.fn(),
  listDeploymentRecords: vi.fn(async () => []),
  readDeploymentRecord: vi.fn(async () => null),
  writeDeploymentRecord: (...args: unknown[]) => writeDeploymentRecordMock(...args),
}));

vi.mock("@/lib/proactive-runtime/hosted-provider", () => ({
  resolveHostedProviderEnvironment: (...args: unknown[]) =>
    resolveHostedProviderEnvironmentMock(...args),
}));

describe("deploy manager hosted-agent integration", () => {
  beforeEach(() => {
    uploadedFiles.clear();
    executedCommands.length = 0;
    createCall = null;
    resolveHostedProviderEnvironmentMock.mockReset();
    writeDeploymentRecordMock.mockReset();
    resolveServerDaytonaAuthParamsMock.mockReset();
    resolveAgentGatewayBaseUrlMock.mockReset();

    resolveHostedProviderEnvironmentMock.mockResolvedValue({
      OPENAI_API_KEY: "sk-managed-test",
    });
    resolveServerDaytonaAuthParamsMock.mockReturnValue({
      daytonaApiKey: "daytona-test-key",
    });
    resolveAgentGatewayBaseUrlMock.mockReturnValue("https://gateway.agentrelay.test");
  });

  it("bundles, provisions, uploads, and persists a hosted agent deployment with trigger metadata", async () => {
    const moduleUrl = new URL(
      "../../../packages/web/lib/proactive-runtime/deploy-manager.ts",
      import.meta.url,
    ).href;
    const { deployHostedAgent } = await import(moduleUrl);

    const result = await deployHostedAgent(
      {
        source: "relay-workspace-token",
        userId: "user_1",
        relayWorkspaceId: "rw_hosted",
        workspaceToken: "relay_ws_token",
        appWorkspaceId: null,
        organizationId: null,
      },
      {
        name: "triage-agent",
        model: "gpt-5",
        instructions: "Summarize the event and write a trace artifact.",
        provider: { mode: "managed" },
        schedule: [{ cron: "*/5 * * * *", tz: "UTC" }],
        watch: ["/linear/issues/**"],
        inbox: ["#support"],
        runtime: {
          mode: "custom",
          onEventSource:
            "async (ctx, event) => { await ctx.files.write(`/_agents/output/${event.id}.json`, { eventType: event.type }); }",
        },
      },
    );

    expect(result).toMatchObject({
      agentId: "triage-agent",
      workspaceId: "rw_hosted",
      status: "running",
    });

    expect(resolveHostedProviderEnvironmentMock).toHaveBeenCalledWith({
      relayWorkspaceId: "rw_hosted",
      model: "gpt-5",
      provider: { mode: "managed" },
      managedResolutionSource: "web-deploy-manager",
    });

    expect(createCall).toMatchObject({
      snapshot: "snapshot-test",
      language: "typescript",
      name: "agent-triage-agent",
      envVars: {
        RELAY_API_KEY: "relay_ws_token",
        RELAY_AGENT_EVENTS_URL: "wss://gateway.agentrelay.test/v1/agent-events",
        NODE_ENV: "production",
        OPENAI_API_KEY: "sk-managed-test",
      },
    });

    const bundlePath = "/home/daytona/proactive-agent/triage-agent/agent.mjs";
    const supervisorPath = "/home/daytona/proactive-agent/triage-agent/supervisor.mjs";

    expect(uploadedFiles.has(bundlePath)).toBe(true);
    expect(uploadedFiles.has(supervisorPath)).toBe(true);

    const bundle = uploadedFiles.get(bundlePath) ?? "";
    expect(bundle).toContain("rw_hosted");
    expect(bundle).toContain("triage-agent");
    expect(bundle).toContain("/linear/issues/**");
    expect(bundle).toContain("#support");
    expect(bundle).toContain("*/5 * * * *");
    expect(bundle).toContain("/_agents/output/");

    const supervisor = uploadedFiles.get(supervisorPath) ?? "";
    expect(supervisor).toContain('const agentId = "triage-agent"');
    expect(supervisor).toContain('const deploymentId = "');
    expect(supervisor).toContain("function launch()");
    expect(supervisor).toContain('writeStatus({ state: "starting", childPid: null })');

    expect(executedCommands).toEqual([
      'mkdir -p "/home/daytona/proactive-agent/triage-agent"',
      'cd "/home/daytona/proactive-agent/triage-agent" && nohup node supervisor.mjs >> "/home/daytona/proactive-agent/triage-agent/runtime.log" 2>&1 < /dev/null &',
    ]);

    expect(writeDeploymentRecordMock).toHaveBeenCalledTimes(1);
    expect(writeDeploymentRecordMock.mock.calls[0]?.[0]).toMatchObject({
      agentId: "triage-agent",
      relayWorkspaceId: "rw_hosted",
      sourceKind: "hosted-custom",
      status: "running",
      hosted: {
        model: "gpt-5",
        instructions: "Summarize the event and write a trace artifact.",
        provider: { mode: "managed" },
      },
      manifest: {
        workspaceLiteral: "rw_hosted",
        agentNameLiteral: "triage-agent",
        schedule: [{ cron: "*/5 * * * *", tz: "UTC" }],
        watch: ["/linear/issues/**"],
        inbox: ["#support"],
      },
      runtime: {
        workdir: "/home/daytona/proactive-agent/triage-agent",
        bundlePath,
        supervisorPath,
        statusPath: "/home/daytona/proactive-agent/triage-agent/status.json",
        logPath: "/home/daytona/proactive-agent/triage-agent/runtime.log",
      },
    });
    expect(
      typeof writeDeploymentRecordMock.mock.calls[0]?.[0]?.bundleHash === "string"
      && writeDeploymentRecordMock.mock.calls[0]?.[0]?.bundleHash.length > 10,
    ).toBe(true);
  });
});
