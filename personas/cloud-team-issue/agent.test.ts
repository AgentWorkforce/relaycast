import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildNonInteractiveSpec, isIntent, parseAgentSpec, parsePersonaSpec } from "@agentworkforce/persona-kit";
import {
  capabilityConfig,
  isPullRequestReviewerPersona,
  isTeamSolvePersona,
} from "../../packages/core/src/proactive-runtime/capabilities";
import persona from "./persona.json";

vi.mock("@agentworkforce/runtime", () => ({
  defineAgent: (spec: Record<string, unknown>) => spec,
}));

const agentModule = await import("./agent");
const agentExport = agentModule.default as {
  triggers?: unknown;
  schedules?: unknown;
  watch?: unknown;
  handler: (ctx: any, event: any) => Promise<void>;
};

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

describe("cloud-team-issue persona declaration", () => {
  it("uses deploy-compatible metadata while matching the web-owned N=1 substrate", () => {
    const deployedAgentSpec = {
      triggers: agentExport.triggers,
      schedules: agentExport.schedules,
      watch: agentExport.watch,
    };

    expect(persona.intent).toBe("relay-orchestrator");
    expect(isIntent(persona.intent)).toBe(true);
    expect(persona).not.toHaveProperty("watch");
    expect(persona).not.toHaveProperty("agent");
    expect(persona).not.toHaveProperty("schedules");
    expect(persona.integrations.github).not.toHaveProperty("triggers");
    expect(() => parsePersonaSpec(persona, persona.intent)).not.toThrow();
    expect(() => parseAgentSpec(deployedAgentSpec, "agent")).not.toThrow();
    expect(isTeamSolvePersona(persona)).toBe(true);
    expect(isPullRequestReviewerPersona(persona)).toBe(false);
    expect(persona.capabilities.teamSolve.enabled).toBe(true);
    expect(capabilityConfig(persona, "teamSolve")).toMatchObject({
      maxMembers: 1,
      roles: ["implementer"],
      tokenBudget: 400000,
      timeBudgetSeconds: 1800,
    });
  });

  it("declares a dormant codex persona for the guarded N=1 launch path", () => {
    expect(persona).toMatchObject({
      id: "cloud-team-issue",
      cloud: true,
      harness: "codex",
      model: "gpt-5",
      capabilities: {
        teamSolve: {
          enabled: true,
          maxMembers: 1,
          roles: ["implementer"],
        },
      },
    });
  });

  it("routes the dormant harness to Codex", () => {
    const spec = buildNonInteractiveSpec({
      harness: persona.harness,
      personaId: persona.id,
      model: persona.model,
      systemPrompt: persona.systemPrompt,
      harnessSettings: persona.harnessSettings,
      mcpServers: {},
      task: "launch probe",
      name: persona.id,
    });

    expect(spec.bin).toBe("codex");
    expect(spec.args).toContain("gpt-5");
  });

  it("declares only the GitHub issue-labeled trigger owned by the web N=1 route", () => {
    expect(agentExport).toMatchObject({
      triggers: {
        github: [
          { on: "issues.labeled", paths: ["/github/repos/AgentWorkforce/cloud/issues/**"] },
        ],
      },
    });
  });
});

describe("cloud-team-issue direct invocation", () => {
  it("stands down without claiming, commenting, workflowing, or spawning a ctx team", async () => {
    const ctx = {
      log: vi.fn(),
      team: { spawn: vi.fn() },
      teams: { spawn: vi.fn() },
      github: { comment: vi.fn() },
      workflow: { run: vi.fn() },
      files: { write: vi.fn() },
    };

    await agentExport.handler(ctx, {
      id: "delivery-1",
      type: "github.issues.labeled",
      resource: {
        path: "/github/repos/AgentWorkforce/cloud/issues/3100",
        kind: "github.issues",
        id: "delivery-1",
        provider: "github",
      },
      expand: async () => ({
        level: "full",
        path: "/github/repos/AgentWorkforce/cloud/issues/3100",
        data: {
          label: { name: "team" },
          issue: { number: 3100, state: "open" },
          repository: { full_name: "AgentWorkforce/cloud" },
        },
      }),
    });

    expect(ctx.log).toHaveBeenCalledWith(
      "info",
      "cloud-team-issue persona is dormant; web teamSolve N=1 adapter owns member launch",
      expect.objectContaining({
        eventId: "delivery-1",
        provider: "github",
        type: "github.issues.labeled",
      }),
    );
    expect(ctx.team.spawn).not.toHaveBeenCalled();
    expect(ctx.teams.spawn).not.toHaveBeenCalled();
    expect(ctx.github.comment).not.toHaveBeenCalled();
    expect(ctx.workflow.run).not.toHaveBeenCalled();
    expect(ctx.files.write).not.toHaveBeenCalled();
  });
});
