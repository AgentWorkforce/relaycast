import { spawnSync } from "node:child_process";
import {
  WORKFORCE_RUNTIME_AWS_SMITHY_SPECS,
  WORKFORCE_RUNTIME_VERSION,
} from "@cloud/core/proactive-runtime/runtime-package.js";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRelayfileMountLifecycleShell } from "@cloud/core/executor/sandbox-orchestrator.js";
import { githubMaterializeOwnerRootsForMountPaths } from "@cloud/core/relayfile/github-materialize.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import complexIssuePersona from "../../../../personas/cloud-complex-issue-workflow/persona.json" with { type: "json" };
import smallIssuePersona from "../../../../personas/cloud-small-issue-codex/persona.json" with { type: "json" };
import teamIssuePersona from "../../../../personas/cloud-team-issue/persona.json" with { type: "json" };

// Local fixture for the external daily-ship persona. The sibling daily repo is
// not available in GitHub Actions, but the trigger shape is the load-bearing bit:
// schedule-only with scoped GitHub/Slack reads and no webhook triggers.
const dailyShipPersona = {
  id: "daily-ship",
  version: "1.0.0",
  intent: "documentation",
  cloud: true,
  integrations: {
    github: {
      source: { kind: "workspace" },
      scope: {
        paths: "/github/repos/AgentWorkforce/*/pulls/**",
      },
    },
    slack: {
      source: { kind: "workspace" },
      scope: {
        users: "/slack/users/**",
        channels: "/slack/channels/**",
      },
    },
  },
  schedules: [
    {
      name: "daily",
      cron: "0 6 * * *",
      tz: "America/New_York",
    },
  ],
  onEvent: "./agent.ts",
} as const;

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  getDb: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@agentworkforce/runtime", () => ({
  defineAgent: (spec: Record<string, unknown>) => spec,
  draftFile: vi.fn(),
  encodeSegment: (value: string | number) => encodeURIComponent(String(value)),
  handler: (fn: unknown) => fn,
  writeJsonFile: vi.fn(),
}));

const teamIssueAgentPath = "../../../../personas/cloud-team-issue/agent";
const teamIssueAgentModule = await import(teamIssueAgentPath);
const teamIssueAgent = teamIssueAgentModule.default as {
  triggers?: unknown;
};

import {
  buildDeploymentInvokeScript,
  buildPerFireSandboxName,
  githubPullRequestWorkspaceFromEnvelope,
  isPullRequestWorkspaceEvent,
  logPersonaRunExitDiagnostic,
  markAgentDispatchResult,
  personaRunOutputTailForDiagnostics,
  proactiveGitWorkspaceFromSources,
  redactRunOutputForDiagnostics,
  relayfileDaemonTokenPathsForRuntimeMountPaths,
  relayfileInitialSyncPaths,
  relayfileMountDaemonTokenConfig,
  relayfileMountPathsForPersona,
  relayfilePathRootsForTokenScope,
  relayfileRuntimeMountPathsForGitWorkspace,
  relayfileRuntimeMountPathsFromPathSets,
  shouldUseLazyReposForDeploymentSpec,
  buildEnvelope,
  envelopeCaptureForStorage,
  ENVELOPE_FIELDS,
  slackWritebackCommandRoots,
} from "./deployment-trigger-delivery";
import { agentMatchesEvent } from "@cloud/core/proactive-runtime/match.js";
import { providerTriggersFromDeploymentSpec } from "@cloud/core/proactive-runtime/agent-spec.js";
import {
  deriveRelayfileMountPaths,
  translatePersonaTriggersToWatchGlobs,
} from "./persona-deploy";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getDb.mockReturnValue({ execute: mocks.execute });
});

const ISSUE_RESOLVER_AGENT_SPEC = {
  triggers: {
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
        paths: ["/slack/channels/proj-cloud/messages/**"],
      },
    ],
  },
};

const ISSUE_RESOLVER_PERSONAS = [
  {
    name: "cloud-small-issue-codex",
    path: "../../../../personas/cloud-small-issue-codex/persona.json",
  },
  {
    name: "cloud-complex-issue-workflow",
    path: "../../../../personas/cloud-complex-issue-workflow/persona.json",
  },
] as const;

function readPersonaConfig(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as Record<string, unknown>;
}

function cloneRecord<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function connectionOnlyPersona(persona: Record<string, unknown>): Record<string, unknown> {
  const migrated = cloneRecord(persona);
  delete migrated.schedules;
  delete migrated.watch;
  const integrations = migrated.integrations;
  if (isRecord(integrations)) {
    for (const config of Object.values(integrations)) {
      if (isRecord(config)) {
        delete config.triggers;
      }
    }
  }
  return migrated;
}

function legacyListenerPersona(persona: Record<string, unknown>): Record<string, unknown> {
  const legacy = connectionOnlyPersona(persona);
  legacy.schedules = [];
  const integrations = legacy.integrations;
  if (!isRecord(integrations)) {
    legacy.integrations = {};
  }
  const nextIntegrations = legacy.integrations as Record<string, unknown>;
  nextIntegrations.github = {
    ...(isRecord(nextIntegrations.github) ? nextIntegrations.github : {}),
    triggers: ISSUE_RESOLVER_AGENT_SPEC.triggers.github,
  };
  nextIntegrations.slack = {
    ...(isRecord(nextIntegrations.slack) ? nextIntegrations.slack : {}),
    triggers: ISSUE_RESOLVER_AGENT_SPEC.triggers.slack,
  };
  return legacy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortedMountScope(scope: {
  relayfilePaths: readonly string[];
  syncPaths: readonly string[];
}): {
  relayfilePaths: string[];
  syncPaths: string[];
} {
  return {
    relayfilePaths: [...scope.relayfilePaths].sort((left, right) => left.localeCompare(right)),
    syncPaths: [...scope.syncPaths].sort((left, right) => left.localeCompare(right)),
  };
}

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks.map((chunk) => {
    if (typeof chunk === "string") {
      return "?";
    }
    const value = (chunk as { value?: unknown }).value;
    return Array.isArray(value) ? value.join("") : "?";
  }).join("");
}

describe("issue resolver agent trigger migration", () => {
  it.each(ISSUE_RESOLVER_PERSONAS)(
    "$name keeps persona.json connection-only when the top-level agent declares triggers",
    ({ path }) => {
      const persona = readPersonaConfig(path);

      expect(persona).not.toHaveProperty("schedules");
      expect(persona).not.toHaveProperty("watch");
      expect(persona).toHaveProperty("integrations.github.source");
      expect(persona).toHaveProperty("integrations.slack.source");
      expect(persona).toHaveProperty("integrations.slack.scope");

      const integrations = persona.integrations;
      expect(isRecord(integrations)).toBe(true);
      for (const [provider, config] of Object.entries(integrations as Record<string, unknown>)) {
        expect(config).not.toHaveProperty("triggers");
        expect(config).toHaveProperty("source");
        if (provider === "slack") {
          expect(config).toHaveProperty("scope");
        }
      }
    },
  );

  it.each(ISSUE_RESOLVER_PERSONAS)(
    "$name preserves runtime-effective relayfile mount and sync scope",
    ({ path }) => {
      const migratedPersona = readPersonaConfig(path);
      const legacyPersona = legacyListenerPersona(migratedPersona);

      expect(sortedMountScope(relayfileMountPathsForPersona(legacyPersona, null))).toEqual(
        sortedMountScope(relayfileMountPathsForPersona(migratedPersona, ISSUE_RESOLVER_AGENT_SPEC)),
      );
    },
  );

  it.each(ISSUE_RESOLVER_PERSONAS)(
    "$name preserves deploy-time mount paths and dispatcher watch globs",
    ({ path }) => {
      const migratedPersona = readPersonaConfig(path);
      const legacyPersona = legacyListenerPersona(migratedPersona);

      expect(deriveRelayfileMountPaths(legacyPersona as never)).toEqual(
        deriveRelayfileMountPaths(migratedPersona as never, ISSUE_RESOLVER_AGENT_SPEC as never),
      );
      expect(translatePersonaTriggersToWatchGlobs(legacyPersona as never)).toEqual(
        translatePersonaTriggersToWatchGlobs(migratedPersona as never, ISSUE_RESOLVER_AGENT_SPEC as never),
      );
    },
  );

  it.each(ISSUE_RESOLVER_PERSONAS)(
    "$name migrated deployment snapshot matches the same trigger events",
    ({ name, path }) => {
      const persona = connectionOnlyPersona(readPersonaConfig(path));
      const snapshot = {
        persona,
        agent: ISSUE_RESOLVER_AGENT_SPEC,
      };
      const watchGlobs = translatePersonaTriggersToWatchGlobs(
        persona as never,
        ISSUE_RESOLVER_AGENT_SPEC as never,
      );
      const row = {
        id: `${name}-deployment`,
        watch_globs: watchGlobs,
        watch_rules: null,
        spec: snapshot,
      };

      expect(providerTriggersFromDeploymentSpec(snapshot, "github")).toEqual(
        ISSUE_RESOLVER_AGENT_SPEC.triggers.github,
      );
      expect(providerTriggersFromDeploymentSpec(snapshot, "slack")).toEqual(
        ISSUE_RESOLVER_AGENT_SPEC.triggers.slack,
      );
      expect(watchGlobs).toEqual([
        "/github/repos/AgentWorkforce/cloud/issues/**",
        "/slack/channels/proj-cloud/messages/**",
      ]);

      expect(agentMatchesEvent({
        row,
        provider: "github",
        eventType: "issues.opened",
        eventPaths: ["/github/repos/AgentWorkforce/cloud/issues/2048.json"],
      })).toBe(true);
      expect(agentMatchesEvent({
        row,
        provider: "github",
        eventType: "issues.labeled",
        eventPaths: ["/github/repos/AgentWorkforce/cloud/issues/2048.json"],
      })).toBe(true);
      expect(agentMatchesEvent({
        row,
        provider: "github",
        eventType: "issues.closed",
        eventPaths: ["/github/repos/AgentWorkforce/cloud/issues/2048.json"],
      })).toBe(false);
      expect(agentMatchesEvent({
        row,
        provider: "github",
        eventType: "issues.opened",
        eventPaths: ["/github/repos/AgentWorkforce/other/issues/2048.json"],
      })).toBe(false);
      expect(agentMatchesEvent({
        row,
        provider: "slack",
        eventType: "message",
        eventPaths: ["/slack/channels/proj-cloud/messages/1710000000.000001.json"],
      })).toBe(true);
      expect(agentMatchesEvent({
        row,
        provider: "slack",
        eventType: "app_mention",
        eventPaths: ["/slack/channels/proj-cloud/messages/1710000000.000001.json"],
      })).toBe(false);
    },
  );
});

describe("cloud-team-issue trigger contract", () => {
  it("declares deploy-compatible teamSolve metadata for the web-owned N=1 issue handler", () => {
    expect(teamIssuePersona).toMatchObject({
      id: "cloud-team-issue",
      intent: "relay-orchestrator",
      capabilities: {
        teamSolve: {
          enabled: true,
          maxMembers: 1,
          roles: ["implementer"],
        },
      },
    });

    expect(teamIssuePersona.integrations.github).not.toHaveProperty("triggers");
    expect(teamIssuePersona).not.toHaveProperty("watch");
    expect(teamIssuePersona).not.toHaveProperty("agent");
    expect(teamIssuePersona).not.toHaveProperty("schedules");
    expect(teamIssueAgent.triggers).toEqual({
      github: [
        {
          on: "issues.labeled",
          paths: ["/github/repos/AgentWorkforce/cloud/issues/**"],
          // Dispatch-level gate: only the `team` label wakes the persona.
          where: "label.name=team",
        },
      ],
    });
  });
});

function mountedInvokeScript(): string {
  return buildDeploymentInvokeScript({
    envVars: {
      WORKFORCE_AGENT_ID: "agent_123",
      RELAYFILE_TOKEN: "relay_pa_env_token",
    },
    envelope: { id: "evt_123", type: "github.issues.opened" },
    mount: {
      baseUrl: "https://relayfile.example",
      workspaceId: "rw_abc12345",
      envToken: "relay_pa_env_token",
      token: "relay_pa_daemon_token",
      tokenPaths: ["/github/**"],
      daemonTokenPaths: ["/github/repos/acme/cloud/issues/42__bug/**"],
      mountPaths: ["/github/repos/**"],
    },
  });
}

function persistedPersonaSpec(persona: Record<string, unknown>): Record<string, unknown> {
  const agent: Record<string, unknown> = {};
  const triggers: Record<string, unknown[]> = {};
  if (isRecord(persona.integrations)) {
    for (const [provider, config] of Object.entries(persona.integrations)) {
      if (isRecord(config) && Array.isArray(config.triggers) && config.triggers.length > 0) {
        triggers[provider] = config.triggers;
      }
    }
  }
  if (Object.keys(triggers).length > 0) {
    agent.triggers = triggers;
  }
  if (Array.isArray(persona.schedules)) {
    agent.schedules = persona.schedules;
  }
  if (Array.isArray(persona.watch)) {
    agent.watch = persona.watch;
  }

  const strippedPersona: Record<string, unknown> = { ...persona };
  delete strippedPersona.schedules;
  delete strippedPersona.watch;
  if (isRecord(persona.integrations)) {
    strippedPersona.integrations = Object.fromEntries(
      Object.entries(persona.integrations).map(([provider, config]) => {
        if (!isRecord(config)) {
          return [provider, config];
        }
        const strippedConfig = { ...config };
        delete strippedConfig.triggers;
        return [provider, strippedConfig];
      }),
    );
  }

  return { persona: strippedPersona, agent };
}

function runDeliveryExitTail(script: string, vars: {
  runnerExit?: number;
  pushExit?: number;
  mountExit?: number;
}): number | null {
  const cleanupIdx = script.indexOf("trap - EXIT INT TERM");
  expect(cleanupIdx).toBeGreaterThan(-1);
  const tail = script.slice(cleanupIdx);
  const result = spawnSync("sh", ["-c", [
    'relayfile_mount_cleanup() { return "${FAKE_MOUNT_EXIT:-0}"; }',
    `FAKE_MOUNT_EXIT=${vars.mountExit ?? 0}`,
    `RUNNER_EXIT=${vars.runnerExit ?? 0}`,
    `PUSH_EXIT=${vars.pushExit ?? 0}`,
    tail,
  ].join("\n")], { encoding: "utf8" });
  return result.status;
}

function runCleanupTimeoutHarness(options: { pendingWrite: boolean }): {
  status: number | null;
  stderr: string;
} {
  const root = mkdtempSync(join(tmpdir(), "relayfile-cleanup-"));
  const workspace = join(root, "workspace");
  const binDir = join(root, "bin");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const timeoutPath = join(binDir, "timeout");
  writeFileSync(timeoutPath, "#!/bin/sh\nexit 124\n");
  chmodSync(timeoutPath, 0o755);

  const marker = join(root, "flush-marker");
  writeFileSync(marker, "");

  if (options.pendingWrite) {
    const commentsDir = join(
      workspace,
      "github/repos/AgentWorkforce/cloud/issues/42/comments",
    );
    mkdirSync(commentsDir, { recursive: true });
    const pendingPath = join(commentsDir, "create comment abc.json");
    writeFileSync(pendingPath, "{}");
    const future = new Date(Date.now() + 10_000);
    utimesSync(pendingPath, future, future);
  }

  const lifecycle = buildRelayfileMountLifecycleShell({
    mount: {
      baseUrl: "https://relayfile.example",
      workspaceId: "rw_abc12345",
      token: "relay_pa_daemon_token",
    },
    localDir: workspace,
    flushTimeoutSeconds: 1,
  });
  const functionIdx = lifecycle.indexOf("relayfile_mount_cleanup() {");
  const trapIdx = lifecycle.indexOf("trap relayfile_mount_cleanup EXIT");
  expect(functionIdx).toBeGreaterThan(-1);
  expect(trapIdx).toBeGreaterThan(functionIdx);
  const cleanupFunction = lifecycle.slice(functionIdx, trapIdx);
  const result = spawnSync("sh", ["-c", [
    `PATH='${binDir}':$PATH`,
    `RELAYFILE_MOUNT_FLUSH_MARKER='${marker}'`,
    "RELAYFILE_MOUNT_PID=",
    cleanupFunction,
    "true",
    "relayfile_mount_cleanup",
    "exit $?",
  ].join("\n")], { encoding: "utf8" });
  return { status: result.status, stderr: result.stderr };
}

// cloud#2029: drive the real cleanup shell with a clean (exit-0) flush so we can
// assert the writeback-delivery signals it emits into the cleanup-status JSON:
// `pendingWriteback` (read from <localDir>/.relay/state.json) and
// `commandDraftWrittenThisRun` (a -newer probe over the command roots).
function runCleanupSignalHarness(options: {
  stateJson?: string | null;
  commandDraft?: boolean;
  /** An INBOUND message mirrored down mid-run (timestamp-named, not a draft). */
  inboundMessage?: boolean;
}): { status: number | null; stderr: string } {
  const root = mkdtempSync(join(tmpdir(), "relayfile-signal-"));
  const workspace = join(root, "workspace");
  const binDir = join(root, "bin");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  // A `timeout` that exits 0 so the flush "succeeds" — isolates signal emission
  // from the 124 path.
  const timeoutPath = join(binDir, "timeout");
  writeFileSync(timeoutPath, "#!/bin/sh\nexit 0\n");
  chmodSync(timeoutPath, 0o755);

  const marker = join(root, "flush-marker");
  writeFileSync(marker, "");

  if (typeof options.stateJson === "string") {
    const relayDir = join(workspace, ".relay");
    mkdirSync(relayDir, { recursive: true });
    writeFileSync(join(relayDir, "state.json"), options.stateJson);
  }

  const commandRoot = join(workspace, "slack/channels/C0B8ZL2L9GC__x/messages");
  mkdirSync(commandRoot, { recursive: true });
  const future = new Date(Date.now() + 10_000);
  if (options.commandDraft) {
    const draftPath = join(commandRoot, "draft-abc.json");
    writeFileSync(draftPath, "{}");
    utimesSync(draftPath, future, future);
  }
  if (options.inboundMessage) {
    // A mirror-down of an inbound Slack message during the run: timestamp-named,
    // newer than the marker, but NOT an agent-authored draft/create file.
    const inboundPath = join(commandRoot, "1710000000.000001.json");
    writeFileSync(inboundPath, "{}");
    utimesSync(inboundPath, future, future);
  }

  const lifecycle = buildRelayfileMountLifecycleShell({
    mount: {
      baseUrl: "https://relayfile.example",
      workspaceId: "rw_abc12345",
      token: "relay_pa_daemon_token",
    },
    localDir: workspace,
    flushTimeoutSeconds: 1,
    cleanupStatusMessage: "relayfile.mount.cleanup",
    commandRootLocalDirs: [commandRoot],
  });
  const functionIdx = lifecycle.indexOf("relayfile_mount_cleanup() {");
  const trapIdx = lifecycle.indexOf("trap relayfile_mount_cleanup EXIT");
  const cleanupFunction = lifecycle.slice(functionIdx, trapIdx);
  const result = spawnSync("sh", ["-c", [
    `PATH='${binDir}':$PATH`,
    `RELAYFILE_MOUNT_FLUSH_MARKER='${marker}'`,
    "RELAYFILE_MOUNT_PID=",
    cleanupFunction,
    "true",
    "relayfile_mount_cleanup",
    "exit $?",
  ].join("\n")], { encoding: "utf8" });
  return { status: result.status, stderr: result.stderr };
}

function parseCleanupJson(stderr: string): Record<string, unknown> {
  const line = stderr
    .split(/\r?\n/u)
    .find((entry) => entry.includes("relayfile.mount.cleanup"));
  expect(line, "cleanup status JSON should be emitted").toBeTruthy();
  return JSON.parse(line as string) as Record<string, unknown>;
}

describe("cleanup writeback-delivery signals (cloud#2029)", () => {
  it("emits pendingWriteback from .relay/state.json and commandDraftWrittenThisRun=true", () => {
    const { stderr } = runCleanupSignalHarness({
      stateJson: JSON.stringify({
        status: "writeback-pending",
        pendingWriteback: 3,
        states: { hasPendingWriteback: true },
      }),
      commandDraft: true,
    });
    const parsed = parseCleanupJson(stderr);
    expect(parsed.pendingWriteback).toBe(3);
    expect(parsed.hasPendingWriteback).toBe(true);
    expect(parsed.commandDraftWrittenThisRun).toBe(true);
  });

  it("emits states.hasPendingWriteback + states.outboxNeedsAttention as bools (cloud#2029 #1)", () => {
    const { stderr } = runCleanupSignalHarness({
      stateJson: JSON.stringify({
        status: "writeback-needs-attention",
        pendingWriteback: 0,
        outbox: { pending: 0, acked: 4 },
        states: { hasPendingWriteback: true, outboxNeedsAttention: true },
      }),
      commandDraft: true,
    });
    const parsed = parseCleanupJson(stderr);
    expect(parsed.pendingWriteback).toBe(0);
    expect(parsed.hasPendingWriteback).toBe(true);
    expect(parsed.outboxNeedsAttention).toBe(true);
  });

  it("defaults the new flags to false when states omits them (pre-#264 backward-safe)", () => {
    const { stderr } = runCleanupSignalHarness({
      stateJson: JSON.stringify({ pendingWriteback: 0, states: { hasPendingWriteback: false } }),
      commandDraft: true,
    });
    const parsed = parseCleanupJson(stderr);
    expect(parsed.hasPendingWriteback).toBe(false);
    expect(parsed.outboxNeedsAttention).toBe(false);
  });

  it("does not false-positive the flags from a per-file 'status' value (grep is states-only safe)", () => {
    // A per-file writeback-pending status must NOT trip the top-level flags.
    const { stderr } = runCleanupSignalHarness({
      stateJson: JSON.stringify({
        pendingWriteback: 0,
        states: { hasPendingWriteback: false, outboxNeedsAttention: false },
        files: { "/slack/channels/C/messages/x.json": { status: "writeback-pending", dirty: true } },
      }),
      commandDraft: true,
    });
    const parsed = parseCleanupJson(stderr);
    expect(parsed.hasPendingWriteback).toBe(false);
    expect(parsed.outboxNeedsAttention).toBe(false);
  });

  it("reports commandDraftWrittenThisRun=false for a read-only run that drafted nothing", () => {
    const { stderr } = runCleanupSignalHarness({
      stateJson: JSON.stringify({ pendingWriteback: 4 }),
      commandDraft: false,
    });
    const parsed = parseCleanupJson(stderr);
    expect(parsed.pendingWriteback).toBe(4);
    expect(parsed.commandDraftWrittenThisRun).toBe(false);
  });

  it("does NOT flag an INBOUND message mirrored down mid-run as a command draft (no #2013 false-alarm)", () => {
    // The command root is a mirror dir; an inbound <ts>.json synced down during
    // the run is -newer than the marker. A read-only run that merely RECEIVED a
    // message must stay commandDraftWrittenThisRun=false even with a backlog.
    const { stderr } = runCleanupSignalHarness({
      stateJson: JSON.stringify({ pendingWriteback: 7 }),
      inboundMessage: true,
      commandDraft: false,
    });
    const parsed = parseCleanupJson(stderr);
    expect(parsed.pendingWriteback).toBe(7);
    expect(parsed.commandDraftWrittenThisRun).toBe(false);
  });

  it("reads pendingWriteback from pretty-printed (spaced) .relay/state.json", () => {
    // Defensive vs a future pretty-printed writer: the sed must tolerate the
    // space after the colon, else it silently defaults to 0 (a false-negative
    // in the anti-silent-loss path).
    const { stderr } = runCleanupSignalHarness({
      stateJson: '{\n  "pendingWriteback": 2,\n  "status": "writeback-pending"\n}',
      commandDraft: true,
    });
    const parsed = parseCleanupJson(stderr);
    expect(parsed.pendingWriteback).toBe(2);
    expect(parsed.commandDraftWrittenThisRun).toBe(true);
  });

  it("defaults pendingWriteback to 0 when .relay/state.json is absent", () => {
    const { stderr } = runCleanupSignalHarness({ stateJson: null, commandDraft: true });
    const parsed = parseCleanupJson(stderr);
    expect(parsed.pendingWriteback).toBe(0);
    expect(parsed.commandDraftWrittenThisRun).toBe(true);
  });

  it("derives Slack command roots only for slack channels/dms/users scopes", () => {
    expect(slackWritebackCommandRoots([
      "/slack/channels/C0B8ZL2L9GC__pear-pty-investigation/**",
      "/slack/users/U0ADJH4P83T/messages",
      "/slack/channels/C123/threads/171234.5678",
      "/slack/channels/C123/threads/171234.5678/replies/**",
      "/slack/discovery/schema/**",
      "/slack/channels",
      "/github/repos/**",
      "/linear/issues/**",
    ])).toEqual([
      "/slack/channels/C0B8ZL2L9GC__pear-pty-investigation/messages",
      "/slack/channels/C123/threads/171234.5678/replies",
      "/slack/users/U0ADJH4P83T/messages",
    ]);
  });

  it("excludes discovery, bare collections, wildcards, and non-slack providers", () => {
    expect(slackWritebackCommandRoots([
      "/slack/discovery/**",
      "/slack/channels",
      "/slack/channels/*/messages",
      "/notion/pages/**",
    ])).toEqual([]);
  });

  it("does not treat a stamped sync revision as pending (revision != delivered)", () => {
    // A synced-but-undispatched draft carries a revision but pendingWriteback 0;
    // the signal must report 0, not be fooled by the revision field.
    const { stderr } = runCleanupSignalHarness({
      stateJson: JSON.stringify({
        pendingWriteback: 0,
        files: { "/slack/users/U/messages/x.json": { revision: "rev_160432", status: "synced" } },
      }),
      commandDraft: true,
    });
    const parsed = parseCleanupJson(stderr);
    expect(parsed.pendingWriteback).toBe(0);
  });
});

// Daytona rejects creating a sandbox with a name that already exists in the
// workspace (`DaytonaConflictError: Sandbox with name <x> already exists`).
// The cold-start runtime architecture in
// `deployment-trigger-delivery.ts` provisions a fresh sandbox on every
// trigger fire, so the per-fire name must include a per-fire token. These
// tests pin the naming scheme so a regression to "name: personaSlug"
// can't ship silently. See PR #954 (rejection-reason logging) for the
// production failure that exposed this.
describe("buildPerFireSandboxName", () => {
  it("includes a per-fire suffix derived from the deploymentId", () => {
    const name = buildPerFireSandboxName({
      personaSlug: "issue-greeter",
      deploymentId: "abcd1234-5678-90ab-cdef-1234567890ab",
    });
    expect(name.startsWith("issue-greeter-")).toBe(true);
    expect(name).toBe("issue-greeter-abcd1234");
  });

  it("produces DIFFERENT names for consecutive fires of the same persona", () => {
    const a = buildPerFireSandboxName({
      personaSlug: "issue-greeter",
      deploymentId: "11111111-1111-1111-1111-111111111111",
    });
    const b = buildPerFireSandboxName({
      personaSlug: "issue-greeter",
      deploymentId: "22222222-2222-2222-2222-222222222222",
    });
    expect(a).not.toBe(b);
    // both still anchored on the persona slug for operator readability
    expect(a.startsWith("issue-greeter-")).toBe(true);
    expect(b.startsWith("issue-greeter-")).toBe(true);
  });

  it("bounds the total name length so Daytona never rejects on length", () => {
    // 63 is the conservative ceiling we picked (well under Daytona's
    // ~100-char limit; matches the Kubernetes DNS-1123 label limit which
    // some Daytona backends inherit).
    const longSlug = "a".repeat(200);
    const name = buildPerFireSandboxName({
      personaSlug: longSlug,
      deploymentId: "abcd1234-5678-90ab-cdef-1234567890ab",
    });
    expect(name.length).toBeLessThanOrEqual(63);
    // suffix is preserved even when the persona slug had to be truncated
    expect(name.endsWith("-abcd1234")).toBe(true);
  });

  it("strips hyphens from the deploymentId so the suffix is opaque", () => {
    // Avoid surprising "trailing dash" / "double dash" edge cases — the
    // suffix should be a single alphanumeric token.
    const name = buildPerFireSandboxName({
      personaSlug: "p",
      deploymentId: "ab-cd-ef-12-34-56-78-90",
    });
    expect(name).toBe("p-abcdef12");
  });

  it("handles short deploymentIds without throwing", () => {
    // Defensive: if a non-UUID ever ends up here we still want a stable
    // name shape rather than an exception that would block the trigger.
    const name = buildPerFireSandboxName({
      personaSlug: "issue-greeter",
      deploymentId: "abc",
    });
    expect(name).toBe("issue-greeter-abc");
  });
});

describe("markAgentDispatchResult", () => {
  it("updates last_used_at only for successful dispatches", async () => {
    await markAgentDispatchResult({ agentId: "agent_123", error: null });

    expect(mocks.execute).toHaveBeenCalledOnce();
    const query = sqlText(mocks.execute.mock.calls[0][0]);
    expect(query).toContain("last_used_at = NOW()");
    expect(query).toContain("last_error = NULL");
  });

  it("preserves last_used_at for failed dispatches", async () => {
    await markAgentDispatchResult({ agentId: "agent_123", error: "runner failed" });

    expect(mocks.execute).toHaveBeenCalledOnce();
    const query = sqlText(mocks.execute.mock.calls[0][0]);
    expect(query).toContain("last_error = ");
    expect(query).not.toContain("last_used_at");
  });
});

describe("githubPullRequestWorkspaceFromEnvelope", () => {
  it("treats pull request review events as PR workspace events", () => {
    expect(isPullRequestWorkspaceEvent({ type: "github.pull_request_review.submitted" }))
      .toBe(true);
    expect(isPullRequestWorkspaceEvent({ type: "github.pull_request_review_comment.created" }))
      .toBe(true);
  });

  it("builds a checkout config from a pull_request_review.submitted payload", () => {
    expect(
      githubPullRequestWorkspaceFromEnvelope({
        id: "evt_review",
        type: "github.pull_request_review.submitted",
        resource: {
          action: "submitted",
          repository: {
            full_name: "AgentWorkforce/cloud",
            clone_url: "https://github.com/AgentWorkforce/cloud.git",
          },
          pull_request: {
            number: 1440,
            head: {
              sha: "head-sha",
              ref: "fix/pr-reviewer-honest-push-outcome",
              repo: { full_name: "AgentWorkforce/cloud" },
            },
            base: {
              sha: "base-sha",
              ref: "main",
              repo: { full_name: "AgentWorkforce/cloud" },
            },
          },
          review: { state: "changes_requested" },
        },
      }),
    ).toEqual({
      owner: "AgentWorkforce",
      repo: "cloud",
      number: 1440,
      baseSha: "base-sha",
      headSha: "head-sha",
      headRef: "fix/pr-reviewer-honest-push-outcome",
      headRepoFullName: "AgentWorkforce/cloud",
      canPush: true,
      remoteUrl: "https://github.com/AgentWorkforce/cloud.git",
    });
  });
});

describe("buildDeploymentInvokeScript", () => {
  it("clones proactive git workspace source before the runner without persisting tokens", () => {
    const script = buildDeploymentInvokeScript({
      envVars: {
        WORKFORCE_AGENT_ID: "agent_123",
        RELAYFILE_TOKEN: "relay_pa_env_token",
      },
      envelope: {
        id: "evt_linear",
        type: "linear.comment.create",
      },
      mount: {
        baseUrl: "https://relayfile.example",
        workspaceId: "rw_abc12345",
        envToken: "relay_pa_env_token",
        token: "relay_pa_daemon_token",
        tokenPaths: ["/github/**", "/linear/**"],
        daemonTokenPaths: ["/github/repos/AgentWorkforce/cloud/**", "/linear/**"],
        mountPaths: [
          "/github/repos/AgentWorkforce/cloud/**",
          "/github/repos/AgentWorkforce/cloud/issues/70/**",
          "/linear/issues/AR-70/**",
        ],
      },
      proactiveGitWorkspace: {
        owner: "AgentWorkforce",
        repo: "cloud",
        remoteUrl: "https://github.com/AgentWorkforce/cloud.git",
        targetDir: "/home/daytona/workspace/github/repos/AgentWorkforce/cloud",
        tokenEnvKey: "GITHUB_PROACTIVE_WORKSPACE_TOKEN",
        username: "x-access-token",
      },
    });

    const cloneIdx = script.indexOf("git clone --filter=blob:none --depth 1 --no-tags");
    const mountIdx = script.indexOf("nohup relayfile-mount");
    const runnerIdx = script.indexOf("node /home/daytona/workforce-runtime/runner.mjs");
    const unsetEnvIdx = script.indexOf("unset GITHUB_PROACTIVE_WORKSPACE_TOKEN");
    const unsetCaptureIdx = script.indexOf("unset PROACTIVE_GIT_WORKSPACE_TOKEN_VALUE");

    expect(cloneIdx).toBeGreaterThan(-1);
    expect(unsetEnvIdx).toBeGreaterThan(-1);
    expect(unsetEnvIdx).toBeLessThan(cloneIdx);
    expect(mountIdx).toBeGreaterThan(cloneIdx);
    expect(unsetCaptureIdx).toBeGreaterThan(cloneIdx);
    expect(unsetCaptureIdx).toBeLessThan(runnerIdx);
    expect(runnerIdx).toBeGreaterThan(mountIdx);
    expect(script).toContain("[proactive-runtime] preparing git workspace source");
    expect(script).toContain("PROACTIVE_GIT_WORKSPACE_TOKEN_VALUE=\"${GITHUB_PROACTIVE_WORKSPACE_TOKEN:-}\"");
    expect(script).not.toContain("export PROACTIVE_GIT_WORKSPACE_TOKEN_VALUE=");
    expect(script).toContain("cat > '/home/daytona/.proactive-git-askpass' <<'EOF'");
    expect(script).toContain("printf '%s\\n' \"$PROACTIVE_GIT_WORKSPACE_TOKEN_VALUE\"");
    expect(script).toContain("PROACTIVE_GIT_WORKSPACE_TOKEN_VALUE=\"$PROACTIVE_GIT_WORKSPACE_TOKEN_VALUE\" git clone --filter=blob:none --depth 1 --no-tags  'https://github.com/AgentWorkforce/cloud.git' '/home/daytona/workspace/github/repos/AgentWorkforce/cloud'");
    expect(script).toContain("git config --global --add safe.directory '/home/daytona/workspace/github/repos/AgentWorkforce/cloud'");
    expect(script).toContain("rm -f '/home/daytona/.proactive-git-askpass'");
    expect(script).not.toContain("x-access-token:");
    expect(script).not.toContain("ghs_");
    expect(script).not.toContain("--remote-path '/github/repos/AgentWorkforce/cloud'");
    expect(script).toContain("--remote-path '/github/repos/AgentWorkforce/cloud/issues/70'");
    expect(script).toContain("--remote-path '/linear/issues/AR-70'");
  });

  it("uses the legacy cold pull request checkout by default before running the runner", () => {
    const script = buildDeploymentInvokeScript({
      envVars: {
        WORKFORCE_AGENT_ID: "agent_123",
        WORKFORCE_SANDBOX_ROOT: "/home/daytona/workspace",
      },
      envelope: {
        id: "evt_pr",
        type: "github.pull_request.opened",
      },
      mount: null,
      pullRequestWorkspace: {
        owner: "AgentWorkforce",
        repo: "cloud",
        number: 1397,
        baseSha: "base-sha",
        headSha: "head-sha",
        headRef: "fix/pr-reviewer-real-checkout",
        headRepoFullName: "AgentWorkforce/cloud",
        canPush: true,
        remoteUrl: "https://github.com/AgentWorkforce/cloud.git",
        tokenEnvKey: "GITHUB_PR_WORKSPACE_TOKEN",
      },
    });

    const installIdx = script.indexOf("cd /home/daytona/workforce-runtime");
    const checkoutIdx = script.indexOf("refs/pull/1397/head");
    const diffIdx = script.indexOf("git diff --binary \"$MERGE_BASE...pr-head\"");
    const guardIdx = script.indexOf("pr-reviewer workspace guard");
    const runnerIdx = script.indexOf("node /home/daytona/workforce-runtime/runner.mjs");

    expect(installIdx).toBeGreaterThan(-1);
    expect(checkoutIdx).toBeGreaterThan(installIdx);
    expect(diffIdx).toBeGreaterThan(checkoutIdx);
    expect(guardIdx).toBeGreaterThan(diffIdx);
    expect(runnerIdx).toBeGreaterThan(guardIdx);
    expect(script).toContain("export WORKFORCE_SANDBOX_ROOT='/home/daytona/workspace'");
    expect(script).toContain("rm -rf /home/daytona/workspace/* /home/daytona/workspace/.[!.]* /home/daytona/workspace/..?*");
    expect(script).toContain("git init /home/daytona/workspace");
    expect(script).toContain("git remote add origin 'https://github.com/AgentWorkforce/cloud.git'");
    expect(script).toContain("git fetch --no-tags --depth=200 origin '+refs/pull/1397/head:refs/remotes/origin/pr/1397/head' '+base-sha:refs/remotes/origin/pr/1397/base'");
    expect(script).not.toContain("git fetch --no-tags --depth=200 origin '+base-sha:refs/remotes/origin/pr/1397/base'");
    expect(script).not.toContain("git update-ref refs/remotes/origin/pr/1397/base");
    expect(script).toContain("git checkout --force -B pr-head");
    expect(script).toContain("git merge-base pr-base pr-head");
    expect(script).toContain("git config --local --unset-all credential.helper");
    expect(script).toContain("rm -f ~/.git-credentials");
    expect(script).toContain("git remote get-url origin | grep -E 'x-access-token|gh[psu]_'");
    expect(script).toContain("if [ -f ~/.git-credentials ]; then echo 'pr-reviewer workspace guard: git credential store file exists'");
    const mkdirWorkforceIdx = script.indexOf("mkdir -p .workforce");
    const excludeIdx = script.indexOf("cat >> .git/info/exclude <<'EOF'");
    expect(excludeIdx).toBeGreaterThan(mkdirWorkforceIdx);
    expect(script).toContain("github/\nslack/\nnode_modules/");
    expect(script).not.toContain("if [ -d /home/daytona/workspace/.git ]; then");
    expect(script).not.toContain("[pr-reviewer] reusing existing pull request workspace checkout");
    expect(script).not.toContain("git remote set-url origin");
    expect(script).not.toContain("git reset --hard");
    expect(script).not.toContain("git clean -ffd");
    expect(script).not.toContain("git clean -ffdx");
    expect(script).toContain(".workforce/pr.diff");
    expect(script).toContain(".workforce/context.json");
    expect(script).toContain("PR diff truncated at");
    expect(script).not.toContain("rm -rf .workforce");
    expect(script).toContain("git diff --name-only \"$MERGE_BASE...pr-head\" > .workforce/changed-files.txt");
    expect(script).toContain("if [ ! -s .workforce/pr.diff ]; then");
    expect(script).toContain("[pr-reviewer] prepared pull request workspace for #1397");
    expect(script.indexOf("unset GITHUB_PR_WORKSPACE_TOKEN")).toBeLessThan(runnerIdx);
  });

  it("uses warm fetch/reset checkout only when the PR warm lease input is enabled", () => {
    const script = buildDeploymentInvokeScript({
      envVars: {
        WORKFORCE_AGENT_ID: "agent_123",
        WORKFORCE_SANDBOX_ROOT: "/home/daytona/workspace",
      },
      envelope: {
        id: "evt_pr",
        type: "github.pull_request.opened",
      },
      mount: null,
      pullRequestWorkspace: {
        owner: "AgentWorkforce",
        repo: "cloud",
        number: 1397,
        baseSha: "base-sha",
        headSha: "head-sha",
        headRef: "fix/pr-reviewer-real-checkout",
        headRepoFullName: "AgentWorkforce/cloud",
        canPush: true,
        remoteUrl: "https://github.com/AgentWorkforce/cloud.git",
        tokenEnvKey: "GITHUB_PR_WORKSPACE_TOKEN",
      },
      pullRequestWarmCheckoutEnabled: true,
    });

    expect(script).toContain("if [ -d /home/daytona/workspace/.git ]; then");
    expect(script).toContain("[pr-reviewer] reusing existing pull request workspace checkout");
    expect(script).toContain("git remote set-url origin 'https://github.com/AgentWorkforce/cloud.git'");
    expect(script).toContain("git init /home/daytona/workspace");
    expect(script).toContain("git reset --hard 'refs/remotes/origin/pr/1397/head'");
    const excludeIdx = script.indexOf("cat > .git/info/exclude <<'EOF'");
    const cleanIdx = script.indexOf("git clean -ffd");
    expect(excludeIdx).toBeGreaterThan(-1);
    expect(cleanIdx).toBeGreaterThan(excludeIdx);
    expect(script).toContain("github/\nslack/\nnode_modules/");
    expect(script).toContain("git clean -ffd");
    expect(script).not.toContain("git clean -ffdx");
    expect(script).toContain("rm -rf .workforce");
    expect(script).toContain("git diff --binary \"$MERGE_BASE...pr-head\"");
  });

  it("pushes same-repo review fixes only after the runner exits and keeps the token out of the runner env", () => {
    const script = buildDeploymentInvokeScript({
      envVars: {
        WORKFORCE_AGENT_ID: "agent_123",
      },
      envelope: {
        id: "evt_pr",
        type: "github.pull_request.opened",
      },
      mount: null,
      pullRequestWorkspace: {
        owner: "AgentWorkforce",
        repo: "cloud",
        number: 1397,
        baseSha: "base-sha",
        headSha: "head-sha",
        headRef: "fix/pr-reviewer-real-checkout",
        headRepoFullName: "AgentWorkforce/cloud",
        canPush: true,
        remoteUrl: "https://github.com/AgentWorkforce/cloud.git",
        tokenEnvKey: "GITHUB_PR_WORKSPACE_TOKEN",
      },
    });

    const unsetIdx = script.indexOf("unset GITHUB_PR_WORKSPACE_TOKEN");
    const runnerIdx = script.indexOf("node /home/daytona/workforce-runtime/runner.mjs");
    const pushIdx = script.indexOf("git push origin 'HEAD:refs/heads/fix/pr-reviewer-real-checkout'");
    const exitIdx = script.indexOf("exit $PUSH_EXIT");

    expect(unsetIdx).toBeGreaterThan(-1);
    expect(unsetIdx).toBeLessThan(runnerIdx);
    expect(pushIdx).toBeGreaterThan(runnerIdx);
    expect(exitIdx).toBeGreaterThan(pushIdx);
    expect(script).toContain("git status --porcelain --untracked-files=all -- '.' ':(exclude)memory/workspace'");
    expect(script).toContain("git commit -m 'chore: apply pr-reviewer fixes for #1397'");
    expect(script).toContain("[pr-reviewer] changed tree detected; committing and pushing fixes");
    expect(script).toContain("[pr-reviewer] clean tree after harness; no push needed");
    expect(script).toContain("[pr-reviewer] pushed fixes for #1397");
    expect(script).toContain("[pr-reviewer] push failed; fetching remote head and retrying once");
    expect(script).toContain("git fetch --no-tags --depth=200 origin '+refs/heads/fix/pr-reviewer-real-checkout:refs/remotes/origin/fix/pr-reviewer-real-checkout'");
    expect(script).toContain("git rebase 'refs/remotes/origin/fix/pr-reviewer-real-checkout'");
    expect(script).toContain("[pr-reviewer] pushed fixes for #1397 after rebase retry");
    expect(script).toContain("[pr-reviewer] push retry failed");
    expect(script).toContain("[pr-reviewer] rebase before push retry failed");
    expect(script).toContain("GIT_ASKPASS=\"$PR_REVIEWER_GIT_ASKPASS\" GITHUB_PR_WORKSPACE_TOKEN=\"$PR_REVIEWER_GIT_TOKEN_VALUE\" git push");
    expect(script).toContain("git push origin 'HEAD:refs/heads/fix/pr-reviewer-real-checkout'");
  });

  it("merges base and finalizes conflict-resolution PR workspaces with a leased merge commit", () => {
    const script = buildDeploymentInvokeScript({
      envVars: {
        WORKFORCE_AGENT_ID: "agent_123",
      },
      envelope: {
        id: "evt_pr_conflict_resolve",
        type: "github.issue_comment.created",
      },
      mount: null,
      pullRequestWorkspace: {
        owner: "AgentWorkforce",
        repo: "cloud",
        number: 1397,
        baseSha: "base-sha",
        headSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        headRef: "fix/pr-reviewer-real-checkout",
        headRepoFullName: "AgentWorkforce/cloud",
        canPush: true,
        remoteUrl: "https://github.com/AgentWorkforce/cloud.git",
        tokenEnvKey: "GITHUB_PR_WORKSPACE_TOKEN",
        mode: "conflictResolve",
      },
    });

    const mergeIdx = script.indexOf("git merge --no-ff --no-commit pr-base");
    const conflictListIdx = script.indexOf("git diff --name-only --diff-filter=U > .workforce/conflicted-files.txt");
    const markerGateIdx = script.indexOf("unresolved conflict markers remain");
    const commitIdx = script.indexOf("elif git commit --no-edit; then");
    const pushIdx = script.indexOf("git push --force-with-lease='refs/heads/fix/pr-reviewer-real-checkout:deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' origin 'HEAD:refs/heads/fix/pr-reviewer-real-checkout'");

    expect(mergeIdx).toBeGreaterThan(-1);
    expect(conflictListIdx).toBeGreaterThan(mergeIdx);
    expect(markerGateIdx).toBeGreaterThan(conflictListIdx);
    expect(commitIdx).toBeGreaterThan(markerGateIdx);
    expect(pushIdx).toBeGreaterThan(commitIdx);
    expect(script).toContain(".workforce/pr-reviewer-conflict-markers.txt");
    expect(script).toContain("PR_REVIEWER_PUSH_BLOCKED_FILES=$(cat .workforce/pr-reviewer-conflict-markers.txt)");
    expect(script).toContain("[pr-reviewer] conflict-resolution push failed; refusing rebase retry");
    expect(script).toContain("unresolved conflict markers remain");
    expect(script).toContain("Cloud refused to finalize or push the merge");
    expect(script).not.toContain("git commit -m 'chore: apply pr-reviewer fixes for #1397'");
  });

  it("excludes relay VFS internals from pr-reviewer push-back commits", () => {
    const script = buildDeploymentInvokeScript({
      envVars: {
        WORKFORCE_AGENT_ID: "agent_123",
      },
      envelope: {
        id: "evt_pr",
        type: "github.pull_request.opened",
      },
      mount: null,
      pullRequestWorkspace: {
        owner: "AgentWorkforce",
        repo: "cloud",
        number: 1397,
        baseSha: "base-sha",
        headSha: "head-sha",
        headRef: "fix/pr-reviewer-real-checkout",
        headRepoFullName: "AgentWorkforce/cloud",
        canPush: true,
        remoteUrl: "https://github.com/AgentWorkforce/cloud.git",
        tokenEnvKey: "GITHUB_PR_WORKSPACE_TOKEN",
      },
    });

    const expectedStatus =
      "CHANGED=$(git status --porcelain --untracked-files=all -- '.' ':(exclude)memory/workspace' ':(exclude).relay' ':(exclude).relay/**' ':(exclude)**/.relay/**')";
    const expectedAdd =
      "git add -A -- '.' ':(exclude)memory/workspace' ':(exclude).relay' ':(exclude).relay/**' ':(exclude)**/.relay/**' || PUSH_EXIT=$?";
    const expectedChangedFiles =
      "git diff --name-only HEAD -- '.' ':(exclude)memory/workspace' ':(exclude).relay' ':(exclude).relay/**' ':(exclude)**/.relay/**' > .workforce/pr-reviewer-local-changed-files.txt";
    const expectedUntrackedFiles =
      "git ls-files --others --exclude-standard -- '.' ':(exclude)memory/workspace' ':(exclude).relay' ':(exclude).relay/**' ':(exclude)**/.relay/**' >> .workforce/pr-reviewer-local-changed-files.txt";
    const unstageIdx = script.indexOf("git reset -q -- 'memory/workspace' '.relay' '**/.relay/**' 2>/dev/null || true");
    const statusIdx = script.indexOf(expectedStatus);
    const changedFilesIdx = script.indexOf(expectedChangedFiles);
    const untrackedFilesIdx = script.indexOf(expectedUntrackedFiles);
    const addIdx = script.indexOf(expectedAdd);
    const commitIdx = script.indexOf("elif git commit -m 'chore: apply pr-reviewer fixes for #1397'");

    expect(unstageIdx).toBeGreaterThan(-1);
    expect(statusIdx).toBeGreaterThan(unstageIdx);
    expect(changedFilesIdx).toBeGreaterThan(statusIdx);
    expect(untrackedFilesIdx).toBeGreaterThan(changedFilesIdx);
    expect(addIdx).toBeGreaterThan(statusIdx);
    expect(commitIdx).toBeGreaterThan(addIdx);
    expect(script).not.toContain("git add -A || PUSH_EXIT=$?");

    const repo = mkdtempSync(join(tmpdir(), "pr-reviewer-vfs-pathspec-"));
    const pushVisiblePathspecs = [
      ".",
      ":(exclude)memory/workspace",
      ":(exclude).relay",
      ":(exclude).relay/**",
      ":(exclude)**/.relay/**",
    ];
    const runGit = (args: string[]) => {
      const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
      }
      return result;
    };

    try {
      runGit(["init", "-q"]);
      runGit(["config", "user.email", "pr-reviewer@example.test"]);
      runGit(["config", "user.name", "PR Reviewer"]);
      writeFileSync(join(repo, "README.md"), "base\n");
      runGit(["add", "README.md"]);
      runGit(["commit", "-q", "-m", "base"]);

      mkdirSync(join(repo, "memory/workspace/.relay"), { recursive: true });
      mkdirSync(join(repo, "nested/.relay"), { recursive: true });
      writeFileSync(join(repo, "memory/workspace/.relay/state.json"), "{}\n");
      writeFileSync(join(repo, "nested/.relay/state.json"), "{}\n");

      const vfsOnlyStatus = runGit([
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        ...pushVisiblePathspecs,
      ]);
      expect(vfsOnlyStatus.stdout).toBe("");
      expect(runGit(["ls-files", "--others", "--exclude-standard", "--", ...pushVisiblePathspecs]).stdout).toBe("");

      writeFileSync(join(repo, "fix.txt"), "real fix\n");
      expect(runGit(["ls-files", "--others", "--exclude-standard", "--", ...pushVisiblePathspecs]).stdout).toBe("fix.txt\n");
      writeFileSync(join(repo, "README.md"), "base\nvisible change\n");
      expect(runGit(["diff", "--name-only", "HEAD", "--", ...pushVisiblePathspecs]).stdout).toBe("README.md\n");
      runGit(["add", "-A", "--", ...pushVisiblePathspecs]);
      const stagedFiles = runGit(["diff", "--cached", "--name-only"]).stdout.trim().split("\n").sort();
      expect(stagedFiles).toEqual(["README.md", "fix.txt"]);

      runGit(["reset", "-q"]);
      runGit(["add", "-f", "memory/workspace/.relay/state.json"]);
      runGit(["reset", "-q", "--", "memory/workspace", ".relay", "**/.relay/**"]);
      expect(runGit(["diff", "--cached", "--name-only"]).stdout).toBe("");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("blocks pr-reviewer push-back when local fixes touch bot-immutable paths", () => {
    const script = buildDeploymentInvokeScript({
      envVars: {
        WORKFORCE_AGENT_ID: "agent_123",
      },
      inputValues: {
        PR_REVIEWER_IMMUTABLE_PATH_DENYLIST: "docs/generated/**,custom/no-bot/**",
      },
      envelope: {
        id: "evt_pr",
        type: "github.pull_request.opened",
      },
      mount: null,
      pullRequestWorkspace: {
        owner: "AgentWorkforce",
        repo: "cloud",
        number: 1397,
        baseSha: "base-sha",
        headSha: "head-sha",
        headRef: "fix/pr-reviewer-real-checkout",
        headRepoFullName: "AgentWorkforce/cloud",
        canPush: true,
        remoteUrl: "https://github.com/AgentWorkforce/cloud.git",
        tokenEnvKey: "GITHUB_PR_WORKSPACE_TOKEN",
      },
    });

    const gateIdx = script.indexOf("[pr-reviewer] changed tree detected; checking push gates");
    const addIdx = script.indexOf("git add -A -- '.' ':(exclude)memory/workspace'");

    expect(gateIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeGreaterThan(gateIdx);
    expect(script).toContain("PR_REVIEWER_IMMUTABLE_PATH_DENYLIST='");
    expect(script).toContain("SNAPSHOT.md");
    expect(script).toContain(".github/workflows/*");
    expect(script).toContain("*snapshot*.test.*");
    expect(script).toContain("*snapshot*.spec.*");
    expect(script).toContain("infra/*snapshot*");
    expect(script).toContain("docs/generated/**");
    expect(script).toContain("custom/no-bot/**");
    expect(script).toContain("bot-immutable path gate blocked push");
    expect(script).toContain("PR_REVIEWER_PUSH_BLOCKED_FILES=\"$PR_REVIEWER_IMMUTABLE_MATCHES\"");
    expect(script).toContain("PUSH_EXIT=93");
    expect(script).toContain("push gate blocked fixes before commit");
    expect(script).toContain("proposed changes touched bot-immutable paths");
    expect(script).toContain("created standalone push-block warning comment draft");
  });

  it("blocks pr-reviewer push-back when prior red CI named a test file the bot edits", () => {
    const script = buildDeploymentInvokeScript({
      envVars: {
        WORKFORCE_AGENT_ID: "agent_123",
      },
      envelope: {
        id: "evt_check",
        type: "github.check_run.completed",
        eventType: "check_run.completed",
        resource: {
          name: "Unit Tests",
          conclusion: "failure",
          output: {
            annotations: [
              { path: "packages/web/lib/proactive-runtime/runtime-snapshot-drift.test.ts" },
            ],
            text: "failed packages/web/lib/proactive-runtime/runtime-snapshot-drift.test.ts",
          },
          pull_requests: [{ number: 1397 }],
          repository: { full_name: "AgentWorkforce/cloud" },
        },
      },
      mount: null,
      pullRequestWorkspace: {
        owner: "AgentWorkforce",
        repo: "cloud",
        number: 1397,
        baseSha: "base-sha",
        headSha: "head-sha",
        headRef: "fix/pr-reviewer-real-checkout",
        headRepoFullName: "AgentWorkforce/cloud",
        canPush: true,
        remoteUrl: "https://github.com/AgentWorkforce/cloud.git",
        tokenEnvKey: "GITHUB_PR_WORKSPACE_TOKEN",
      },
    });

    expect(script).toContain("PR_REVIEWER_EXPECTED_RED_SEED_PATHS='packages/web/lib/proactive-runtime/runtime-snapshot-drift.test.ts'");
    expect(script).toContain("PR_REVIEWER_EXPECTED_RED_REASON='Unit Tests failure'");
    expect(script).toContain("expected-red test gate blocked push");
    expect(script).toContain("PR_REVIEWER_PUSH_BLOCKED_FILES=$(cat .workforce/pr-reviewer-expected-red-blocked.txt)");
    expect(script).toContain("PUSH_EXIT=94");
    expect(script).toContain("CI was already red for test files");
    expect(script).toContain("/commits/\" + encodeURIComponent(headSha) + \"/check-runs?per_page=100&filter=latest");
    expect(script).toContain("/check-runs/\" + encodeURIComponent(String(run.id)) + \"/annotations?per_page=100");
    expect(script).toContain("PR_REVIEWER_EXPECTED_RED_REASON=\"$PR_REVIEWER_EXPECTED_RED_REASON\" node -e");
  });

  it("does not infer pushback from a tokenless pull request checkout", () => {
    const script = buildDeploymentInvokeScript({
      envVars: {
        WORKFORCE_AGENT_ID: "agent_123",
      },
      envelope: {
        id: "evt_pr",
        type: "github.pull_request.opened",
      },
      mount: null,
      pullRequestWorkspace: {
        owner: "AgentWorkforce",
        repo: "cloud",
        number: 1397,
        baseSha: "base-sha",
        headSha: "head-sha",
        headRef: "fix/pr-reviewer-real-checkout",
        headRepoFullName: "AgentWorkforce/cloud",
        canPush: true,
        remoteUrl: "https://github.com/AgentWorkforce/cloud.git",
        tokenEnvKey: null,
      },
    });

    expect(script).toContain("[pr-reviewer] preparing pull request workspace");
    expect(script).toContain("refs/pull/1397/head");
    expect(script).not.toContain("[pr-reviewer] creating formal pull request review draft");
    expect(script).not.toContain("\"reviews\"");
    expect(script).not.toContain("PR_REVIEWER_GIT_TOKEN_VALUE");
    expect(script).not.toContain("GIT_ASKPASS");
    expect(script).not.toContain("[pr-reviewer] changed tree detected; committing and pushing fixes");
    expect(script).not.toContain("git push origin");
    expect(script).not.toContain("[pr-reviewer] annotating review comment with authoritative push outcome");
  });

  it("keeps pr-reviewer findings on one issue-comment surface before flushing Relayfile", () => {
    const script = buildDeploymentInvokeScript({
      envVars: {
        WORKFORCE_AGENT_ID: "agent_123",
        RELAYFILE_TOKEN: "relay_pa_env_token",
      },
      envelope: {
        id: "evt_pr",
        type: "github.pull_request.opened",
        paths: ["/github/repos/AgentWorkforce/cloud/pulls/1420__probe5/meta.json"],
      },
      mount: {
        baseUrl: "https://relayfile.example",
        workspaceId: "rw_abc12345",
        envToken: "relay_pa_env_token",
        token: "relay_pa_daemon_token",
        tokenPaths: ["/github/**"],
        daemonTokenPaths: ["/github/**"],
        mountPaths: [],
      },
      pullRequestWorkspace: {
        owner: "AgentWorkforce",
        repo: "cloud",
        number: 1420,
        baseSha: "base-sha",
        headSha: "head-sha",
        headRef: "fix/probe5",
        headRepoFullName: "AgentWorkforce/cloud",
        canPush: true,
        remoteUrl: "https://github.com/AgentWorkforce/cloud.git",
        tokenEnvKey: "GITHUB_PR_WORKSPACE_TOKEN",
      },
    });

    const runnerIdx = script.indexOf("node /home/daytona/workforce-runtime/runner.mjs");
    const pushExitIdx = script.indexOf("if [ \"$PUSH_EXIT\" -ne 0 ]; then exit $PUSH_EXIT; fi");
    const annotateIdx = script.indexOf("[pr-reviewer] annotating review comment with authoritative push outcome");
    const flushIdx = script.indexOf("MOUNT_EXIT=$?");

    expect(annotateIdx).toBeGreaterThan(runnerIdx);
    expect(flushIdx).toBeGreaterThan(annotateIdx);
    expect(pushExitIdx).toBeGreaterThan(flushIdx);
    expect(script).toContain("\"issues\",");
    expect(script).toContain("\"comments\"");
    expect(script).toContain("<!-- pr-reviewer-push-outcome -->");
    expect(script).not.toContain("[pr-reviewer] creating formal pull request review draft");
    expect(script).not.toContain("\"reviews\"");
    expect(script).not.toContain("create review ");
    expect(script).not.toContain("JSON.stringify({ event: \"COMMENT\", body, comments: [] }, null, 2)");
    expect(script).toContain("--remote-path '/github/repos/AgentWorkforce/cloud/pulls/1420__probe5'");
    expect(script).toContain("--remote-path '/github/repos/AgentWorkforce/cloud/pulls/1420'");
    expect(script).toContain("--remote-path '/github/repos/AgentWorkforce/cloud/issues/1420'");
  });

  it("annotates the review comment with the authoritative push outcome without mirroring a formal review", () => {
    const script = buildDeploymentInvokeScript({
      envVars: { WORKFORCE_AGENT_ID: "agent_123" },
      envelope: {
        id: "evt_pr",
        type: "github.pull_request.opened",
        paths: ["/github/repos/AgentWorkforce/cloud/pulls/1420__probe5/meta.json"],
      },
      mount: {
        baseUrl: "https://relayfile.example",
        workspaceId: "rw_abc12345",
        envToken: "relay_pa_env_token",
        token: "relay_pa_daemon_token",
        tokenPaths: ["/github/**"],
        daemonTokenPaths: ["/github/**"],
        mountPaths: [],
      },
      pullRequestWorkspace: {
        owner: "AgentWorkforce",
        repo: "cloud",
        number: 1420,
        baseSha: "base-sha",
        headSha: "head-sha",
        headRef: "fix/probe5",
        headRepoFullName: "AgentWorkforce/cloud",
        canPush: true,
        remoteUrl: "https://github.com/AgentWorkforce/cloud.git",
        tokenEnvKey: "GITHUB_PR_WORKSPACE_TOKEN",
      },
    });

    // The push-back script records whether anything actually landed.
    expect(script).toContain("PR_REVIEWER_PUSHED=0");
    expect(script).toContain("PR_REVIEWER_PUSHED=1");
    expect(script).toContain("PR_REVIEWER_PUSHED_SHA=$(git rev-parse HEAD");
    // The outcome annotator passes the real push state into the rewriter and
    // tags the draft with a sentinel so it is idempotent. The env assignments
    // MUST be on the same command as `node -e` or node reads empty env and
    // mislabels every push as "review only".
    const annotateCommandIdx = script.indexOf(
      'PR_REVIEWER_PUSH_EXIT="$PUSH_EXIT"',
    );
    expect(annotateCommandIdx).toBeGreaterThan(-1);
    expect(script.slice(annotateCommandIdx)).toContain(
      'PR_REVIEWER_PUSHED="$PR_REVIEWER_PUSHED"',
    );
    expect(script.slice(annotateCommandIdx)).toContain(
      'PR_REVIEWER_PUSHED_SHA="$PR_REVIEWER_PUSHED_SHA"',
    );
    expect(script.slice(annotateCommandIdx, annotateCommandIdx + 300)).toContain(
      "node -e",
    );
    expect(script).toContain("<!-- pr-reviewer-push-outcome -->");
    expect(script).toContain("pr-reviewer applied fixes");
    expect(script).toContain("pr-reviewer: review only");
    expect(script).toContain("pr-reviewer did not push");

    // It must run AFTER the push (so PUSH_EXIT is known), and the removed
    // formal-review mirror must stay absent; otherwise GitHub gets the same
    // body on two separate surfaces.
    const pushIdx = script.indexOf("git push origin 'HEAD:refs/heads/fix/probe5'");
    const annotateIdx = script.indexOf("annotating review comment with authoritative push outcome");
    expect(pushIdx).toBeGreaterThan(-1);
    expect(annotateIdx).toBeGreaterThan(pushIdx);
    expect(script).not.toContain("creating formal pull request review draft");
    expect(script).not.toContain("\"reviews\"");
  });

  it("fails loudly when another fire clobbers the prepared pull request checkout", () => {
    const script = buildDeploymentInvokeScript({
      envVars: {
        WORKFORCE_AGENT_ID: "agent_123",
      },
      envelope: {
        id: "evt_pr",
        type: "github.pull_request.opened",
      },
      mount: null,
      pullRequestWorkspace: {
        owner: "AgentWorkforce",
        repo: "cloud",
        number: 1397,
        baseSha: "base-sha",
        headSha: "head-sha",
        headRef: "fix/pr-reviewer-real-checkout",
        headRepoFullName: "AgentWorkforce/cloud",
        canPush: true,
        remoteUrl: "https://github.com/AgentWorkforce/cloud.git",
        tokenEnvKey: "GITHUB_PR_WORKSPACE_TOKEN",
      },
    });

    const guardIdx = script.indexOf("CURRENT_PR_HEAD=$(git rev-parse HEAD");
    const statusIdx = script.indexOf("git status --porcelain --untracked-files=all -- '.' ':(exclude)memory/workspace'");
    const cleanNoopIdx = script.indexOf("[pr-reviewer] clean tree after harness; no push needed");

    expect(script).toContain("EXPECTED_PR_HEAD='head-sha'");
    expect(script).toContain("workspace checkout changed before push for #1397; refusing clean-tree noop");
    expect(script).toContain("PUSH_EXIT=92");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(statusIdx);
    expect(guardIdx).toBeLessThan(cleanNoopIdx);
    const guardBlock = script.slice(guardIdx, statusIdx);
    expect(guardBlock).not.toContain("push failed; fetching remote head and retrying once");
    expect(guardBlock).not.toContain("git rebase");
    expect(script.indexOf("push failed; fetching remote head and retrying once")).toBeGreaterThan(statusIdx);
  });

  it("surfaces git add and commit failures as post-harness push failures", () => {
    const script = buildDeploymentInvokeScript({
      envVars: {
        WORKFORCE_AGENT_ID: "agent_123",
      },
      envelope: {
        id: "evt_pr",
        type: "github.pull_request.opened",
      },
      mount: null,
      pullRequestWorkspace: {
        owner: "AgentWorkforce",
        repo: "cloud",
        number: 1397,
        baseSha: "base-sha",
        headSha: "head-sha",
        headRef: "fix/pr-reviewer-real-checkout",
        headRepoFullName: "AgentWorkforce/cloud",
        canPush: true,
        remoteUrl: "https://github.com/AgentWorkforce/cloud.git",
        tokenEnvKey: "GITHUB_PR_WORKSPACE_TOKEN",
      },
    });

    const addIdx = script.indexOf("git add -A -- '.' ':(exclude)memory/workspace'");
    const commitIdx = script.indexOf("elif git commit -m 'chore: apply pr-reviewer fixes for #1397'");
    const pushIdx = script.indexOf("git push origin 'HEAD:refs/heads/fix/pr-reviewer-real-checkout'");
    const exitIdx = script.indexOf("exit $PUSH_EXIT");

    expect(script).toContain("git add -A -- '.' ':(exclude)memory/workspace'");
    expect(script).toContain("[pr-reviewer] push preparation failed before commit");
    expect(script).toContain("elif git commit -m 'chore: apply pr-reviewer fixes for #1397'");
    expect(script).toContain("PUSH_EXIT=$?");
    expect(script).toContain("[pr-reviewer] commit failed");
    expect(addIdx).toBeGreaterThan(-1);
    expect(commitIdx).toBeGreaterThan(addIdx);
    expect(pushIdx).toBeGreaterThan(commitIdx);
    expect(exitIdx).toBeGreaterThan(pushIdx);
  });

  it("fails loudly when a fork PR produces local fixes that cannot be pushed", () => {
    const script = buildDeploymentInvokeScript({
      envVars: {},
      envelope: { id: "evt_pr", type: "github.pull_request.opened" },
      mount: null,
      pullRequestWorkspace: {
        owner: "AgentWorkforce",
        repo: "cloud",
        number: 1397,
        baseSha: "base-sha",
        headSha: "head-sha",
        headRef: "contributor-branch",
        headRepoFullName: "external/cloud",
        canPush: false,
        remoteUrl: "https://github.com/AgentWorkforce/cloud.git",
        tokenEnvKey: "GITHUB_PR_WORKSPACE_TOKEN",
      },
    });

    expect(script).toContain("cannot push pr-reviewer fixes for fork or read-only PR");
    expect(script).toContain("[pr-reviewer] changed tree detected, but push-back is disabled for this PR");
    expect(script).toContain("[pr-reviewer] clean tree after harness; no push needed");
    expect(script).not.toContain("git push origin HEAD:refs/heads/contributor-branch");
    expect(script).toContain("GIT_ASKPASS=\"$PR_REVIEWER_GIT_ASKPASS\" GITHUB_PR_WORKSPACE_TOKEN=\"$PR_REVIEWER_GIT_TOKEN_VALUE\" git fetch");
    expect(script).not.toContain("push failed; fetching remote head and retrying once");
    expect(script).not.toContain("git rebase 'refs/remotes/origin/contributor-branch'");
  });

  it("runs a scoped relayfile mount around the runner and surfaces flush failures", () => {
    const script = mountedInvokeScript();

    const mountIdx = script.indexOf("RELAYFILE_MOUNT_PID=");
    const runnerIdx = script.indexOf("node runner.mjs");
    const flushIdx = script.indexOf("MOUNT_EXIT=$?");

    expect(mountIdx).toBeGreaterThan(-1);
    expect(runnerIdx).toBeGreaterThan(mountIdx);
    expect(flushIdx).toBeGreaterThan(runnerIdx);
    // The daemon accepts repeated --remote-path values. The continuous
    // daemon and cleanup flush must stay scoped so large workspaces never
    // fall back to a full /fs/export pull.
    expect(script).not.toMatch(/\s--paths(?:\s|$)/);
    expect(script).toContain("--remote-path '/github/repos'");
    expect(script).toContain("export RELAYFILE_TOKEN='relay_pa_env_token'");
    expect(script).toContain("--token 'relay_pa_daemon_token'");
    expect(script).not.toContain("--token 'relay_pa_env_token'");
    expect(script).toContain("trap relayfile_mount_cleanup EXIT");
    expect(script).toContain("trap 'relayfile_mount_cleanup; exit $?' INT TERM");
    expect(script).toContain("--websocket=false");
    expect(script).toContain("--interval '3s'");
    expect(script).toContain('timeout 75s env RELAYFILE_MOUNT_LOCAL_LAYOUT=scoped relayfile-mount "$relayfile_mount_flush_mode"');
    expect(script).toContain('"message":"relayfile.mount.cleanup"');
    expect(script).toContain("__RELAYFILE_MOUNT_LOG_TAIL_START__");
    expect(script).toContain("tail -c 65536 /tmp/relayfile-mount.log");
    expect(script).toContain("tail -n 200");
    expect(script).toContain("__RELAYFILE_MOUNT_LOG_TAIL_END__");
    expect(script).toContain('exit "$MOUNT_EXIT"');
    expect(script).toContain("relayfile_mount_cleanup || MOUNT_EXIT=$?");
    expect(script).toContain("RELAYFILE_MOUNT_FLUSH_MARKER=$(mktemp");
    expect(script).toContain("scoped initial sync failed; continuing without preloaded reads");
    expect(script).not.toContain("relayfile-mount.log 2>&1 || true");
  });

  it("does not let a clean mount cleanup shadow push failures", () => {
    const status = runDeliveryExitTail(mountedInvokeScript(), {
      pushExit: 92,
      mountExit: 0,
    });

    expect(status).toBe(92);
  });

  it("keeps mount failures last in delivery exit precedence", () => {
    const status = runDeliveryExitTail(mountedInvokeScript(), {
      mountExit: 124,
    });

    expect(status).toBe(124);
  });

  it("treats a cleanup timeout with no pending local writes as clean", () => {
    const result = runCleanupTimeoutHarness({ pendingWrite: false });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "cleanup sync timed out with no pending local writes; treating as clean",
    );
  });

  it("surfaces a cleanup timeout when local writebacks are pending", () => {
    const result = runCleanupTimeoutHarness({ pendingWrite: true });

    expect(result.status).toBe(124);
    expect(result.stderr).not.toContain(
      "cleanup sync timed out with no pending local writes; treating as clean",
    );
  });

  it("runs an event-scoped initial sync before the runner when the envelope has a concrete path", () => {
    const script = buildDeploymentInvokeScript({
      envVars: {
        WORKFORCE_AGENT_ID: "agent_123",
        RELAYFILE_TOKEN: "relay_pa_env_token",
      },
      envelope: {
        id: "evt_123",
        type: "github.issues.opened",
        paths: ["/github/repos/acme/cloud/issues/42__bug/meta.json"],
      },
      mount: {
        baseUrl: "https://relayfile.example",
        workspaceId: "rw_abc12345",
        envToken: "relay_pa_env_token",
        token: "relay_pa_daemon_token",
        tokenPaths: ["/github/**"],
        daemonTokenPaths: ["/github/repos/acme/cloud/issues/42__bug/**"],
        mountPaths: [],
      },
    });

    const initialSyncIdx = script.indexOf("--remote-path '/github/repos/acme/cloud/issues/42__bug'");
    const runnerIdx = script.indexOf("node runner.mjs");

    expect(initialSyncIdx).toBeGreaterThan(-1);
    expect(runnerIdx).toBeGreaterThan(initialSyncIdx);
    expect(script).not.toMatch(/\s--paths(?:\s|$)/);
    expect(script).toContain("nohup relayfile-mount");
    expect(script).not.toContain("--lazy-repos");
    expect(script).toContain("--local-dir '/home/daytona/workspace'");
    expect(script).not.toContain("issues/42__bug/github/repos/acme/cloud/issues/42__bug");
    // cloud #1516 interim: outer wrapper idle raised 90 to 300s, matched by the
    // daemon's internal RELAYFILE_BOOTSTRAP_IDLE_TIMEOUT (set together so the
    // lower one can't cancel a slow-but-progressing bootstrap first).
    expect(script).toContain("relayfile initial sync made no progress for 300s; canceling");
    expect(script).toContain("export RELAYFILE_BOOTSTRAP_IDLE_TIMEOUT=300s");
    expect(script).toContain("scoped initial sync failed; continuing without preloaded reads");
    expect(script).toMatch(/if ! \( set -- '\/tmp\/relayfile-mount-initial-sync-0\.json'(?: '[^']+')*;/);
    expect(script).toContain("exit \"$relayfile_mount_status\"; ) >> /tmp/relayfile-mount.log 2>&1; then");
    expect(script).not.toContain("if ! { set -- '/tmp/relayfile-mount-initial-sync-0.json';");
  });

  it("mounts the Slack reply writeback subtree for threaded mention events", () => {
    const script = buildDeploymentInvokeScript({
      envVars: {
        WORKFORCE_AGENT_ID: "agent_123",
        RELAYFILE_TOKEN: "relay_pa_env_token",
      },
      envelope: {
        id: "evt_slack_thread",
        type: "slack.app_mention",
        paths: ["/slack/channels/C123/threads/1711111000_000100/replies/1711111222_000300/meta.json"],
      },
      mount: {
        baseUrl: "https://relayfile.example",
        workspaceId: "rw_abc12345",
        envToken: "relay_pa_env_token",
        token: "relay_pa_daemon_token",
        tokenPaths: ["/slack/**"],
        daemonTokenPaths: ["/slack/**"],
        mountPaths: [],
      },
    });

    expect(script).toContain("--remote-path '/slack/channels/C123/threads/1711111000_000100/replies/1711111222_000300'");
    expect(script).toContain("--remote-path '/slack/channels/C123/messages/1711111000_000100/replies'");
    expect(script).toContain("--local-dir '/home/daytona/workspace'");
    expect(script).not.toContain("replies/slack/channels/C123");
  });

  it("mounts canonical GitHub issue and pull request writeback subtrees for pull request events", () => {
    const script = buildDeploymentInvokeScript({
      envVars: {
        WORKFORCE_AGENT_ID: "agent_123",
        RELAYFILE_TOKEN: "relay_pa_env_token",
      },
      envelope: {
        id: "evt_pr",
        type: "github.pull_request.opened",
        paths: ["/github/repos/acme/cloud/pulls/42__review-me/meta.json"],
      },
      mount: {
        baseUrl: "https://relayfile.example",
        workspaceId: "rw_abc12345",
        envToken: "relay_pa_env_token",
        token: "relay_pa_daemon_token",
        tokenPaths: ["/github/**"],
        daemonTokenPaths: ["/github/**"],
        mountPaths: [],
      },
    });

    expect(script).toContain("--remote-path '/github/repos/acme/cloud/pulls/42__review-me'");
    expect(script).toContain("--remote-path '/github/repos/acme/cloud/pulls/42'");
    expect(script).toContain("--remote-path '/github/repos/acme/cloud/issues/42'");
    expect(script).not.toContain("--local-dir '/home/daytona/workspace/github/repos/acme/cloud/pulls/42'");
    expect(script).not.toContain("--local-dir '/home/daytona/workspace/github/repos/acme/cloud/issues/42'");
  });

  it("runs persona-scoped initial sync paths without using provider roots for the pre-run sync", () => {
    const script = buildDeploymentInvokeScript({
      envVars: {
        WORKFORCE_AGENT_ID: "agent_123",
        RELAYFILE_TOKEN: "relay_pa_env_token",
      },
      envelope: { id: "evt_123", type: "cron.tick" },
      mount: {
        baseUrl: "https://relayfile.example",
        workspaceId: "rw_abc12345",
        token: "relay_pa_daemon_token",
        tokenPaths: ["/github/**"],
        daemonTokenPaths: ["/github/repos/AgentWorkforce/proactive-agents/**"],
        mountPaths: [],
        syncPaths: ["/github/repos/AgentWorkforce/proactive-agents/**", "/github/**"],
      },
    });

    expect(script).not.toMatch(/\s--paths(?:\s|$)/);
    expect(script).not.toContain("--remote-path '/github'");
    expect(script).toContain("nohup relayfile-mount");
    expect(script).not.toContain("--lazy-repos");
    expect(script).toContain("--state-dir '/home/daytona/.relayfile-mount-state'");
    expect(script).toContain("--remote-path '/github/repos/AgentWorkforce/proactive-agents'");
    expect(script).toContain("--local-dir '/home/daytona/workspace'");
    expect(script).not.toContain("proactive-agents/github/repos/AgentWorkforce/proactive-agents");
    expect(script).toContain("relayfile initial sync made no progress for 300s; canceling");
    expect(script).not.toContain("--local-dir '/home/daytona/workspace/github' --state-dir '/home/daytona/.relayfile-mount-state' --token 'relay_pa_token' --remote-path '/github' --state-file");
  });

  it("extracts only broad GitHub owner roots for pre-run materialization", () => {
    expect(githubMaterializeOwnerRootsForMountPaths([
      "/github/repos/AgentWorkforce/**",
      "/github/repos/AgentWorkforce/*/pulls/**",
      "/github/repos/acme",
      "/github/repos/acme/cloud/issues/**",
      "/github/repos/acme/cloud/pulls/42__review-me/**",
      "/linear/issues/**",
    ])).toEqual(["acme", "AgentWorkforce"]);
  });

  it("materializes scheduled org-scan repos before the lazy relayfile mount", () => {
    const persisted = persistedPersonaSpec(dailyShipPersona);
    const persona = persisted.persona as Record<string, unknown>;
    const agentSpec = persisted.agent as Parameters<typeof shouldUseLazyReposForDeploymentSpec>[0];
    const script = buildDeploymentInvokeScript({
      envVars: {
        WORKFORCE_AGENT_ID: "agent_123",
        RELAYFILE_TOKEN: "relay_pa_env_token",
      },
      envelope: { id: "evt_123", type: "cron.tick" },
      persona,
      agentSpec,
      mount: {
        baseUrl: "https://relayfile.example",
        workspaceId: "rw_abc12345",
        token: "relay_pa_daemon_token",
        tokenPaths: ["/github/**"],
        daemonTokenPaths: ["/github/repos/AgentWorkforce/**"],
        mountPaths: ["/github/repos/AgentWorkforce/**"],
        syncPaths: ["/github/repos/AgentWorkforce/**"],
      },
    });

    const daemonIdx = script.indexOf("nohup relayfile-mount");
    const initialSyncIdx = script.indexOf("relayfile-mount --once");
    const materializeIdx = script.indexOf("materializing recent GitHub repos before relayfile mount");
    const runnerIdx = script.indexOf("node runner.mjs");

    expect(daemonIdx).toBeGreaterThan(-1);
    expect(materializeIdx).toBeGreaterThan(-1);
    expect(initialSyncIdx).toBeGreaterThan(materializeIdx);
    expect(daemonIdx).toBeGreaterThan(materializeIdx);
    expect(runnerIdx).toBeGreaterThan(initialSyncIdx);
    expect(dailyShipPersona.schedules).toHaveLength(1);
    expect(dailyShipPersona.integrations.github).not.toHaveProperty("triggers");
    expect((agentSpec as { schedules?: unknown[] }).schedules).toHaveLength(1);
    expect(persona).not.toHaveProperty("schedules");
    expect(shouldUseLazyReposForDeploymentSpec(
      persona as Parameters<typeof shouldUseLazyReposForDeploymentSpec>[0],
    )).toBe(false);
    expect(shouldUseLazyReposForDeploymentSpec(agentSpec, persona)).toBe(true);
    expect(script).toContain("--lazy-repos --remote-path '/github/repos/AgentWorkforce'");
    expect(script).toContain("/github/repos/_index.json");
    expect(script).toContain("/github/repos/\" + owner + \"/_index.json");
    expect(script).toContain("/integrations/github/repos/");
    expect(script).toContain("RELAYFILE_GITHUB_MATERIALIZE_LOOKBACK_HOURS");
    expect(script).toContain("RELAYFILE_GITHUB_MATERIALIZE_TOTAL_TIMEOUT_MS");
    expect(script).toContain("github repo materialize failed");
    expect(script).toContain("github materialize incomplete");
  });

  it("treats the separate agent spec as authoritative over wrapper-era inner persona leftovers", () => {
    const persisted = persistedPersonaSpec(dailyShipPersona);
    const legacyResolverPersona = legacyListenerPersona(
      smallIssuePersona as Record<string, unknown>,
    );
    const persona = {
      ...(persisted.persona as Record<string, unknown>),
      integrations: legacyResolverPersona.integrations,
    };
    const agentSpec = persisted.agent as Parameters<typeof shouldUseLazyReposForDeploymentSpec>[0];

    expect((persona.integrations as { github?: { triggers?: unknown[] } }).github?.triggers)
      .toHaveLength(2);
    expect(shouldUseLazyReposForDeploymentSpec(agentSpec, persona)).toBe(true);
  });

  it("supports flat legacy schedule-only personas when no separate agent spec exists", () => {
    const script = buildDeploymentInvokeScript({
      envVars: {
        WORKFORCE_AGENT_ID: "agent_123",
        RELAYFILE_TOKEN: "relay_pa_env_token",
      },
      envelope: { id: "evt_123", type: "cron.tick" },
      persona: dailyShipPersona,
      mount: {
        baseUrl: "https://relayfile.example",
        workspaceId: "rw_abc12345",
        token: "relay_pa_daemon_token",
        tokenPaths: ["/github/**"],
        daemonTokenPaths: ["/github/repos/AgentWorkforce/**"],
        mountPaths: ["/github/repos/AgentWorkforce/**"],
        syncPaths: ["/github/repos/AgentWorkforce/**"],
      },
    });

    expect(shouldUseLazyReposForDeploymentSpec(null, dailyShipPersona)).toBe(true);
    expect(script).toContain("--lazy-repos --remote-path '/github/repos/AgentWorkforce'");
    expect(script).toContain("materializing recent GitHub repos before relayfile mount");
  });

  it("keeps flat legacy webhook personas eager when no separate agent spec exists", () => {
    const legacyPersona: Record<string, unknown> = {
      ...legacyListenerPersona(smallIssuePersona as Record<string, unknown>),
      schedules: dailyShipPersona.schedules,
    };

    expect((legacyPersona.integrations as { github?: { triggers?: unknown[] } }).github?.triggers)
      .toHaveLength(2);
    expect(shouldUseLazyReposForDeploymentSpec(null, legacyPersona)).toBe(false);
  });

  it("keeps #1656 agent-block resolver specs eager for the proven resolver personas", () => {
    for (const persona of [smallIssuePersona, complexIssuePersona]) {
      const unwrappedPersona = connectionOnlyPersona(persona as Record<string, unknown>);
      const agentSpec = ISSUE_RESOLVER_AGENT_SPEC as Parameters<typeof shouldUseLazyReposForDeploymentSpec>[0];
      const mountPaths = deriveRelayfileMountPaths(
        unwrappedPersona as Parameters<typeof deriveRelayfileMountPaths>[0],
        agentSpec as never,
      );
      const script = buildDeploymentInvokeScript({
        envVars: {
          WORKFORCE_AGENT_ID: "agent_123",
          RELAYFILE_TOKEN: "relay_pa_env_token",
        },
        envelope: { id: "evt_123", type: "github.issues.opened" },
        persona: unwrappedPersona,
        agentSpec,
        mount: {
          baseUrl: "https://relayfile.example",
          workspaceId: "rw_abc12345",
          token: "relay_pa_daemon_token",
          tokenPaths: ["/github/**", "/slack/**"],
          daemonTokenPaths: mountPaths,
          mountPaths,
          syncPaths: mountPaths,
        },
      });

      expect(persona).not.toHaveProperty("schedules");
      expect((persona as { integrations?: { github?: unknown } }).integrations?.github)
        .not.toHaveProperty("triggers");
      expect((agentSpec as { triggers?: { github?: unknown[] } }).triggers?.github).toHaveLength(2);
      expect((unwrappedPersona as { integrations?: { github?: unknown } }).integrations?.github)
        .not.toHaveProperty("triggers");
      expect(shouldUseLazyReposForDeploymentSpec(agentSpec, unwrappedPersona)).toBe(false);
      expect(mountPaths).toContain("/github/repos/AgentWorkforce/cloud/issues/**");
      expect(script).toContain("--remote-path '/github/repos/AgentWorkforce/cloud/issues'");
      expect(script).not.toContain("--lazy-repos");
      expect(script).not.toContain("materializing recent GitHub repos before relayfile mount");
    }
  });

  it("keeps webhook-triggered persisted specs eager even when a future mount is broad", () => {
    const persona = connectionOnlyPersona(smallIssuePersona as Record<string, unknown>);
    const agentSpec = ISSUE_RESOLVER_AGENT_SPEC as Parameters<typeof shouldUseLazyReposForDeploymentSpec>[0];
    const script = buildDeploymentInvokeScript({
      envVars: {
        WORKFORCE_AGENT_ID: "agent_123",
        RELAYFILE_TOKEN: "relay_pa_env_token",
      },
      envelope: { id: "evt_123", type: "github.issues.opened" },
      persona,
      agentSpec,
      mount: {
        baseUrl: "https://relayfile.example",
        workspaceId: "rw_abc12345",
        token: "relay_pa_daemon_token",
        tokenPaths: ["/github/**"],
        daemonTokenPaths: ["/github/repos/AgentWorkforce/**"],
        mountPaths: ["/github/repos/AgentWorkforce/**"],
        syncPaths: ["/github/repos/AgentWorkforce/**"],
      },
    });

    expect(script).toContain("--remote-path '/github/repos/AgentWorkforce'");
    expect(script).not.toContain("--lazy-repos");
  });

  it("keeps cloud-small-issue-codex daemon paths narrow while mounting canonical writeback companions", () => {
    const script = buildDeploymentInvokeScript({
      envVars: {
        WORKFORCE_AGENT_ID: "agent_123",
        RELAYFILE_TOKEN: "relay_pa_env_token",
      },
      envelope: {
        id: "evt_123",
        type: "github.issues.opened",
        paths: ["/github/repos/AgentWorkforce/cloud/issues/1093__fix-stale-comment/meta.json"],
      },
      mount: {
        baseUrl: "https://relayfile.example",
        workspaceId: "rw_abc12345",
        envToken: "relay_pa_env_token",
        token: "relay_pa_daemon_token",
        tokenPaths: ["/github/**", "/slack/**"],
        daemonTokenPaths: [
          "/github/repos/AgentWorkforce/cloud/issues/1093/**",
          "/github/repos/AgentWorkforce/cloud/issues/1093__fix-stale-comment/**",
          "/slack/channel/proj-cloud/**",
          "/slack/channels/proj-cloud/messages/**",
        ],
        mountPaths: [
          "/github/repos/AgentWorkforce/cloud/issues/**",
          "/slack/channel/proj-cloud/**",
          "/slack/channels/proj-cloud/messages/**",
        ],
      },
    });

    expect(script).not.toContain("--remote-path '/github'");
    expect(script).not.toContain("--local-dir '/home/daytona/workspace/github'");
    expect(script).toContain("export RELAYFILE_TOKEN='relay_pa_env_token'");
    expect(script).toContain("--token 'relay_pa_daemon_token'");
    expect(script).not.toContain("--token 'relay_pa_env_token'");
    expect(script).toContain("--remote-path '/github/repos/AgentWorkforce/cloud/issues'");
    expect(script).toContain("--remote-path '/github/repos/AgentWorkforce/cloud/issues/1093__fix-stale-comment'");
    expect(script).toContain("--remote-path '/github/repos/AgentWorkforce/cloud/issues/1093'");
    expect(script).toContain("--remote-path '/slack/channel/proj-cloud'");
    expect(script).toContain("--remote-path '/slack/channels/proj-cloud/messages'");
  });

  it("omits relayfile-mount commands when no mount config is available", () => {
    const script = buildDeploymentInvokeScript({
      envVars: {
        WORKFORCE_AGENT_ID: "agent_123",
        RELAYFILE_TOKEN: "",
        RELAYFILE_MOUNT_PATHS: "[]",
      },
      envelope: { id: "evt_123" },
      mount: null,
    });

    expect(script).not.toContain("relayfile-mount");
    expect(script).not.toContain("__RELAYFILE_MOUNT_LOG_TAIL_START__");
    expect(script).toContain("export RELAYFILE_TOKEN=''");
    expect(script).toContain("exit $RUNNER_EXIT");
  });

  it("skips install only when the baked runtime version matches, otherwise installs exact runtime", () => {
    const script = buildDeploymentInvokeScript({
      envVars: {},
      envelope: { id: "evt_123", type: "cron.tick" },
      mount: null,
    });

    expect(script).toContain("RUNTIME_VERSION=");
    expect(script).toContain("RUNTIME_DEPS_OK=");
    expect(script).toContain(`[ \"$RUNTIME_VERSION\" = \"${WORKFORCE_RUNTIME_VERSION}\" ]`);
    expect(script).toContain(`[ \"$RUNTIME_DEPS_OK\" = \"1\" ]`);
    const runtimeDepsProbe = script.slice(
      script.indexOf("RUNTIME_DEPS_OK="),
      script.indexOf(`if [ "$RUNTIME_VERSION" = "${WORKFORCE_RUNTIME_VERSION}" ]`),
    );
    expect(runtimeDepsProbe).toContain("@aws-sdk/client-s3");
    expect(runtimeDepsProbe).toContain("@aws-sdk/client-sts");
    expect(runtimeDepsProbe).toContain("@aws-sdk/lib-storage");
    expect(script).toContain(`runtime ${WORKFORCE_RUNTIME_VERSION} pre-baked into snapshot; skip install`);
    expect(script).toContain(`baked runtime version $RUNTIME_VERSION != ${WORKFORCE_RUNTIME_VERSION}`);
    expect(script).toContain("baked runtime dependency closure failed health check");
    // The mismatch path must be a direct --no-save exact install. The
    // uploaded bundle's package.json materializes read-only (Daytona
    // uploadBundle mode 0444), so the previous in-place patch
    // (writeFileSync) died with EACCES — and the npm install that
    // followed reconciled node_modules against the unpatched `{}`,
    // REMOVING the entire baked runtime tree (hn-monitor first fire,
    // 2026-06-03: ERR_MODULE_NOT_FOUND '@agentworkforce/runtime').
    // --no-save never touches package.json and never reconcile-prunes.
    expect(script).toContain(
      `npm install --omit=dev --no-audit --no-fund --no-save @agentworkforce/runtime@${WORKFORCE_RUNTIME_VERSION}`,
    );
    for (const spec of WORKFORCE_RUNTIME_AWS_SMITHY_SPECS) {
      expect(script).toContain(spec);
    }
    expect(script).not.toContain("node <<'NODE'");
    expect(script).not.toContain("fs.writeFileSync('package.json'");
    expect(script).not.toContain("npm init -y");
    expect(script).toContain("[proactive-runtime] runtime load failed:");
    expect(script).toContain("@aws-sdk/client-s3");
    expect(script).toContain("@aws-sdk/client-sts");
    expect(script).toContain("@aws-sdk/lib-storage");
    expect(script).toContain("@smithy/smithy-client");
    expect(script).toContain("typeof smithy.emitWarningIfUnsupportedVersion");
    expect(script).toContain("emitWarningIfUnsupportedVersion");
    expect(script).not.toContain("--prefer-offline");
    expect(script).not.toContain("@agentworkforce/runtime@^");
  });

  it("exits before runner execution and push-back when runtime setup install fails", () => {
    const root = mkdtempSync(join(tmpdir(), "runtime-setup-gate-"));
    try {
      const binDir = join(root, "bin");
      mkdirSync(binDir, { recursive: true });
      const markerPath = join(root, "events.log");
      const nodePath = join(binDir, "node");
      writeFileSync(nodePath, [
        "#!/bin/sh",
        "printf 'node %s\\n' \"$*\" >> \"$SETUP_GATE_MARKER\"",
        "case \"$*\" in",
        "  *runner.mjs*) printf 'runner\\n' >> \"$SETUP_GATE_MARKER\"; exit 0 ;;",
        "  *) exit 1 ;;",
        "esac",
        "",
      ].join("\n"));
      chmodSync(nodePath, 0o755);
      const npmPath = join(binDir, "npm");
      writeFileSync(npmPath, [
        "#!/bin/sh",
        "printf 'npm %s\\n' \"$*\" >> \"$SETUP_GATE_MARKER\"",
        "exit 37",
        "",
      ].join("\n"));
      chmodSync(npmPath, 0o755);
      const gitPath = join(binDir, "git");
      writeFileSync(gitPath, [
        "#!/bin/sh",
        "printf 'git %s\\n' \"$*\" >> \"$SETUP_GATE_MARKER\"",
        "exit 0",
        "",
      ].join("\n"));
      chmodSync(gitPath, 0o755);

      const script = buildDeploymentInvokeScript({
        envVars: {},
        envelope: { id: "evt_123", type: "cron.tick" },
        mount: null,
        pullRequestWritebackWorkspace: {
          owner: "AgentWorkforce",
          repo: "cloud",
          number: 1940,
          baseSha: "base-sha",
          headSha: "head-sha",
          headRef: "fix-push-gate-1926",
          headRepoFullName: "AgentWorkforce/cloud",
          canPush: true,
          remoteUrl: "https://github.com/AgentWorkforce/cloud.git",
          tokenEnvKey: "GITHUB_PR_WORKSPACE_TOKEN",
        },
      });
      const setupIdx = script.indexOf("RUNTIME_VERSION=");
      const finalExit = "exit \"$MOUNT_EXIT\"";
      const exitIdx = script.lastIndexOf(finalExit);
      expect(setupIdx).toBeGreaterThan(-1);
      expect(exitIdx).toBeGreaterThan(setupIdx);

      const result = spawnSync("bash", ["-c", script.slice(setupIdx, exitIdx + finalExit.length)], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          SETUP_GATE_MARKER: markerPath,
        },
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("[proactive-runtime] npm install failed with exit code 37");
      const events = readFileSync(markerPath, "utf8");
      expect(events).toContain("npm install --omit=dev --no-audit --no-fund --no-save");
      expect(events).not.toContain("runner");
      expect(events).not.toContain("git status");
      expect(events).not.toContain("git push");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("relayfileRuntimeMountPathsFromPathSets", () => {
  it("keeps the slugged GitHub issue context and adds the canonical issue writeback companion", () => {
    expect(
      relayfileRuntimeMountPathsFromPathSets({
        mountPaths: [],
        eventSyncPaths: ["/github/repos/acme/cloud/issues/1566__e2e-probe/meta.json"],
      }),
    ).toEqual([
      "/github/repos/acme/cloud/issues/1566__e2e-probe/meta.json",
      "/github/repos/acme/cloud/issues/1566/**",
    ]);
  });

  it("keeps the slugged GitHub pull request context and adds canonical writeback companions", () => {
    expect(
      relayfileRuntimeMountPathsFromPathSets({
        mountPaths: [],
        eventSyncPaths: ["/github/repos/acme/cloud/pulls/77__review-me/**"],
      }),
    ).toEqual([
      "/github/repos/acme/cloud/issues/77/**",
      "/github/repos/acme/cloud/pulls/77__review-me/**",
      "/github/repos/acme/cloud/pulls/77/**",
    ]);
  });

  it("dedupes explicit plain companions when the slugged issue root is present", () => {
    expect(
      relayfileRuntimeMountPathsFromPathSets({
        mountPaths: [
          "/github/repos/acme/cloud/issues/1566/**",
          "/github/repos/acme/cloud/issues/1566__e2e-probe/**",
        ],
      }),
    ).toEqual([
      "/github/repos/acme/cloud/issues/1566__e2e-probe/**",
      "/github/repos/acme/cloud/issues/1566/**",
    ]);
  });
});

describe("proactive git workspace source", () => {
  it("derives the default GitHub clone target from a persona repo scope", () => {
    expect(
      proactiveGitWorkspaceFromSources({
        envelope: { id: "evt_linear", type: "linear.comment.create" },
        relayfilePaths: ["/github/repos/AgentWorkforce/cloud/**", "/linear/**"],
      }),
    ).toEqual({
      owner: "AgentWorkforce",
      repo: "cloud",
      remoteUrl: "https://github.com/AgentWorkforce/cloud.git",
      targetDir: "/home/daytona/workspace/github/repos/AgentWorkforce/cloud",
    });
  });

  it("does not guess when multiple GitHub repo scopes are present", () => {
    expect(
      proactiveGitWorkspaceFromSources({
        envelope: { id: "evt_linear", type: "linear.comment.create" },
        relayfilePaths: [
          "/github/repos/AgentWorkforce/cloud/**",
          "/github/repos/AgentWorkforce/agents/**",
        ],
      }),
    ).toBeNull();
  });

  it("uses concrete GitHub event repository metadata when available", () => {
    expect(
      proactiveGitWorkspaceFromSources({
        envelope: {
          id: "evt_issue",
          type: "github.issues.opened",
          resource: {
            repository: {
              full_name: "AgentWorkforce/cloud",
              clone_url: "https://github.com/AgentWorkforce/cloud.git",
              default_branch: "main",
            },
          },
        },
        relayfilePaths: ["/github/repos/**/**/issues/**"],
      }),
    ).toEqual({
      owner: "AgentWorkforce",
      repo: "cloud",
      remoteUrl: "https://github.com/AgentWorkforce/cloud.git",
      targetDir: "/home/daytona/workspace/github/repos/AgentWorkforce/cloud",
      ref: "main",
    });
  });

  it("ignores unsafe GitHub event repository names before deriving a local clone path", () => {
    expect(
      proactiveGitWorkspaceFromSources({
        envelope: {
          id: "evt_issue",
          type: "github.issues.opened",
          resource: {
            repository: {
              full_name: "AgentWorkforce/.",
              clone_url: "https://github.com/AgentWorkforce/cloud.git",
              default_branch: "main",
            },
          },
        },
        relayfilePaths: ["/github/repos/**/**/issues/**"],
      }),
    ).toBeNull();
  });

  it("keeps object/writeback subtrees mounted while excluding broad repo source sync", () => {
    expect(
      relayfileRuntimeMountPathsForGitWorkspace({
        gitWorkspace: { owner: "AgentWorkforce", repo: "cloud" },
        paths: [
          "/github/repos/AgentWorkforce/cloud/**",
          "/github/repos/AgentWorkforce/cloud/contents/**",
          "/github/repos/AgentWorkforce/cloud/git/**",
          "/github/repos/AgentWorkforce/cloud/issues/70/**",
          "/github/repos/AgentWorkforce/cloud/pulls/72/**",
          "/linear/issues/AR-70/**",
        ],
      }),
    ).toEqual([
      "/github/repos/AgentWorkforce/cloud/issues/70/**",
      "/github/repos/AgentWorkforce/cloud/pulls/72/**",
      "/linear/issues/AR-70/**",
    ]);
  });
});

describe("relayfileDaemonTokenPathsForRuntimeMountPaths", () => {
  it("uses the broad env token for per-fire mount daemons while preserving narrow mount paths elsewhere", () => {
    expect(
      relayfileMountDaemonTokenConfig({
        envToken: "relay_pa_env_token",
        tokenPaths: ["/slack/**", "/github/**"],
      }),
    ).toEqual({
      token: "relay_pa_env_token",
      daemonTokenPaths: ["/github/**", "/slack/**"],
    });
  });

  it("keeps launch-time daemon mounting disabled when requested", () => {
    expect(
      relayfileMountDaemonTokenConfig({
        envToken: "relay_pa_env_token",
        tokenPaths: ["/github/**"],
        mintDaemonToken: false,
      }),
    ).toEqual({
      token: "",
      daemonTokenPaths: [],
    });
  });

  it("keeps only concrete event/writeback paths for daemon token minting", () => {
    expect(
      relayfileDaemonTokenPathsForRuntimeMountPaths([
        "/github/**",
        "/github/repos/AgentWorkforce/cloud/issues/**",
        "/github/repos/AgentWorkforce/cloud/issues/1095/**",
        "/github/repos/AgentWorkforce/cloud/issues/1095__fix-stale-comment/**",
        "/github/repos/**/**/issues/**",
        "/slack/**",
        "/slack/channel/proj-cloud/**",
        "/slack/channels/**/messages/**",
      ]),
    ).toEqual([
      "/github/repos/AgentWorkforce/cloud/issues/1095__fix-stale-comment/**",
      "/github/repos/AgentWorkforce/cloud/issues/1095/**",
      "/slack/channel/proj-cloud/**",
      "/slack/channels/proj-cloud/messages/**",
    ]);
  });

  it("preserves GitHub issue and pull companions for daemon token minting", () => {
    expect(
      relayfileDaemonTokenPathsForRuntimeMountPaths([
        "/github/repos/acme/cloud/issues/1566__e2e-probe/**",
        "/github/repos/acme/cloud/pulls/77__review-me/**",
      ]),
    ).toEqual([
      "/github/repos/acme/cloud/issues/1566__e2e-probe/**",
      "/github/repos/acme/cloud/issues/1566/**",
      "/github/repos/acme/cloud/issues/77/**",
      "/github/repos/acme/cloud/pulls/77__review-me/**",
      "/github/repos/acme/cloud/pulls/77/**",
    ]);
  });

  it("returns [] instead of falling back to provider roots when no concrete daemon paths exist", () => {
    expect(
      relayfileDaemonTokenPathsForRuntimeMountPaths([
        "/github/**",
        "/github/repos/AgentWorkforce/cloud/issues/**",
        "/slack/**",
        "/slack/channels/**/messages/**",
      ]),
    ).toEqual([]);
  });
});

// Production-observed failure post-#969 deploy: every proactive tick warned
// `[persona-bundle-deploy] tick path-token mint failed; continuing without
// RELAYFILE_TOKEN`, error
// `relayauth path-token mint failed: 400 paths must contain valid relayfile paths`.
// Root cause: `relayfilePathsForIntegrations` produces multi-wildcard paths
// (e.g. `/github/repos/**/**/issues/**`), but relayauth's
// `normalizePathTokenPath` only accepts a SINGLE trailing `*` after a `/`.
// `relayfilePathRootsForTokenScope` collapses derived paths to per-provider
// roots (`/github/**`) which relayauth normalizes server-side to `/github/*`.
describe("relayfilePathRootsForTokenScope", () => {
  it("collapses multi-wildcard github paths to a single provider root", () => {
    expect(
      relayfilePathRootsForTokenScope([
        "/github/repos/**/**/issues/**",
        "/github/repos/**/**/pulls/**",
      ]),
    ).toEqual(["/github/**"]);
  });

  it("dedupes + sorts across multiple providers", () => {
    expect(
      relayfilePathRootsForTokenScope([
        "/notion/databases/**/pages/**",
        "/github/repos/**/**/issues/**",
        "/notion/databases/**/pages/**",
      ]),
    ).toEqual(["/github/**", "/notion/**"]);
  });

  it("skips paths missing a leading slash or with a wildcard first segment", () => {
    expect(
      relayfilePathRootsForTokenScope([
        "github/foo/**", // missing leading /
        "/**/anything", // wildcard first segment
        "",
        "/linear/issues/**",
      ]),
    ).toEqual(["/linear/**"]);
  });

  it("returns [] for an empty input", () => {
    expect(relayfilePathRootsForTokenScope([])).toEqual([]);
  });

  it("memory scopes are preserved alongside provider scopes", () => {
    // `deriveRelayfileMountPaths` adds `/memory/<scope>/**` entries when the
    // persona declares memory.scopes. Those should also reduce to a single
    // `/memory/**` root since relayauth rejects the multi-wildcard form.
    expect(
      relayfilePathRootsForTokenScope([
        "/memory/workspace/**",
        "/memory/global/**",
        "/github/repos/**/**/issues/**",
      ]),
    ).toEqual(["/github/**", "/memory/**"]);
  });
});

// TEMPORARY (instrument-dont-guess, #1516): persona-run-exit diagnostic
// redaction + tail-bounding. Locks CIGate's secret-hygiene + bounded-output
// constraints. Remove with the diagnostic once the in-sandbox cause is found.
describe("persona-run-exit diagnostic redaction", () => {
  it("scrubs every GitHub token shape this delivery path can mint", () => {
    const out = redactRunOutputForDiagnostics(
      [
        "cloning https://x-access-token:ghs_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA@github.com/acme/cloud.git",
        "token=ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        "oauth gho_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC ghu_DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
        "askpass printed x-access-token:ghs_EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
      ].join("\n"),
    );
    // No raw GitHub token of any prefix survives.
    expect(out).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}/);
    // The x-access-token basic-auth username is preserved but the secret is gone.
    expect(out).toContain("x-access-token:[REDACTED]");
    // The non-secret remainder of the URL is preserved for diagnostic value.
    expect(out).toContain("github.com/acme/cloud.git");
  });

  it("scrubs the secret shapes redactText already covers (Bearer / AWS / api_key)", () => {
    const out = redactRunOutputForDiagnostics(
      [
        "Authorization: Bearer sk-ant-SECRETSECRETSECRETSECRET",
        "AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE",
        '"api_key":"super-secret-value"',
      ].join("\n"),
    );
    expect(out).not.toContain("sk-ant-SECRETSECRETSECRETSECRET");
    expect(out).not.toContain("super-secret-value");
    expect(out).toContain("[REDACTED]");
  });

  it("preserves non-secret diagnostic content so the tail is still useful", () => {
    const out = redactRunOutputForDiagnostics(
      "ERROR: cannot find module '@anthropic-ai/sdk' — exiting with code 1",
    );
    expect(out).toContain("cannot find module");
    expect(out).toContain("exiting with code 1");
  });

  it("bounds the tail to the last 50 lines and a hard byte cap", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line-${i}`);
    const tail = personaRunOutputTailForDiagnostics(lines.join("\n"));
    const tailLines = tail.split("\n");
    expect(tailLines.length).toBeLessThanOrEqual(50);
    // keeps the END (the failure is usually last), not the start.
    expect(tail).toContain("line-199");
    expect(tail).not.toContain("line-0\n");

    const huge = "x".repeat(20_000);
    expect(personaRunOutputTailForDiagnostics(huge).length).toBeLessThanOrEqual(4096 + 32);
  });

  it("returns empty for empty output (no crash, nothing to log)", () => {
    expect(personaRunOutputTailForDiagnostics("")).toBe("");
  });
});

describe("logPersonaRunExitDiagnostic", () => {
  it("emits one structured line with the per-stream byte breakdown + redacted tail", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      logPersonaRunExitDiagnostic({
        terminalReason: "error",
        deploymentId: "dep_1",
        agentId: "agent_1",
        personaSlug: "cloud-small-issue-codex",
        deployedName: "small",
        sandboxId: "sb_1",
        sessionId: "tick-1",
        commandId: "cmd_1",
        exitCode: 137,
        durationMs: 1234,
        ageSeconds: 1,
        maxAgeSeconds: 1800,
        output: "boom: token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA leaked",
        logs: { stdout: "", stderr: "boom: token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA leaked", output: "" },
      });
      expect(spy).toHaveBeenCalledTimes(1);
      const [message, payload] = spy.mock.calls[0] as [string, Record<string, unknown>];
      expect(message).toContain("[persona-run-exit]");
      expect(payload.area).toBe("integration-watch-delivery");
      expect(payload.diag).toBe("persona-run-exit");
      expect(payload.terminalReason).toBe("error");
      expect(payload.exitCode).toBe(137);
      expect(payload.stdoutBytes).toBe(0);
      expect(payload.stderrBytes).toBeGreaterThan(0);
      // The tail is redacted — the leaked token must never reach the log.
      expect(String(payload.outputTail)).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
      expect(String(payload.outputTail)).toContain("boom:");
    } finally {
      spy.mockRestore();
    }
  });

  it("reports an all-zero breakdown when the runner produced no captured output", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      logPersonaRunExitDiagnostic({
        terminalReason: "error",
        deploymentId: "dep_2",
        agentId: "agent_2",
        personaSlug: null,
        deployedName: null,
        sandboxId: "sb_2",
        sessionId: "tick-2",
        commandId: "cmd_2",
        exitCode: 1,
        durationMs: 10,
        ageSeconds: 1,
        maxAgeSeconds: 1800,
        output: "",
        logs: null,
      });
      const payload = spy.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(payload.stdoutBytes).toBe(0);
      expect(payload.stderrBytes).toBe(0);
      expect(payload.outputFieldBytes).toBe(0);
      expect(payload.combinedOutputBytes).toBe(0);
      expect(payload.outputTail).toBe("");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("relayfileInitialSyncPaths (cloud #1516 — bootstrap excludes writeback companions)", () => {
  it("excludes the plain issue companion when the slugged issue primary is present (no slugged+plain dup full-pull)", () => {
    const roots = relayfileInitialSyncPaths([
      "/github/repos/acme/cloud/issues/1543__probe-s2-title/**", // slugged primary (read root, from eventSync)
      "/github/repos/acme/cloud/issues/1543/**", // plain companion (writeback target)
    ]);
    expect(roots).toEqual([
      "/github/repos/acme/cloud/issues/1543__probe-s2-title/**",
    ]);
  });

  it("keeps a bare issue root that has NO slugged sibling (its-own-companion guard — never drops a primary)", () => {
    const roots = relayfileInitialSyncPaths([
      "/github/repos/acme/cloud/issues/1543/**",
    ]);
    expect(roots).toEqual(["/github/repos/acme/cloud/issues/1543/**"]);
  });

  it("for a slugged PR primary, excludes BOTH issues/N and pulls/N companions but keeps the PR read-root", () => {
    const roots = relayfileInitialSyncPaths([
      "/github/repos/acme/cloud/pulls/77__fix-title/**", // slugged PR primary (read root)
      "/github/repos/acme/cloud/issues/77/**", // companion (writeback)
      "/github/repos/acme/cloud/pulls/77/**", // companion (writeback)
    ]);
    expect(roots).toEqual(["/github/repos/acme/cloud/pulls/77__fix-title/**"]);
  });

  it("leaves unrelated read primaries (e.g. memory) bootstrapped", () => {
    const roots = relayfileInitialSyncPaths([
      "/github/repos/acme/cloud/issues/9__t/**",
      "/github/repos/acme/cloud/issues/9/**", // companion
      "/memory/threads/abc/**",
    ]);
    expect(roots).toEqual([
      "/github/repos/acme/cloud/issues/9__t/**",
      "/memory/threads/abc/**",
    ]);
  });
});

describe("relayfileRuntimeMountPathsFromPathSets writeback companions", () => {
  it("mounts the canonical plain issue writeback root alongside a slugged issue context root", () => {
    expect(
      relayfileRuntimeMountPathsFromPathSets({
        mountPaths: [],
        syncPaths: [],
        eventSyncPaths: [
          "/github/repos/acme/cloud/issues/1543__probe-s2-title/**",
        ],
      }),
    ).toEqual([
      "/github/repos/acme/cloud/issues/1543__probe-s2-title/**",
      "/github/repos/acme/cloud/issues/1543/**",
    ]);
  });

  it("mounts canonical issue and PR writeback roots alongside a slugged PR context root", () => {
    expect(
      relayfileRuntimeMountPathsFromPathSets({
        mountPaths: [],
        syncPaths: [],
        eventSyncPaths: [
          "/github/repos/acme/cloud/pulls/77__fix-title/**",
        ],
      }),
    ).toEqual([
      "/github/repos/acme/cloud/issues/77/**",
      "/github/repos/acme/cloud/pulls/77__fix-title/**",
      "/github/repos/acme/cloud/pulls/77/**",
    ]);
  });
});

describe("relayfileInitialSyncPaths — glob-insensitive companion exclusion (cloud #1516 hardening)", () => {
  it("excludes a NON-globbed plain issue companion when the slugged primary is globbed", () => {
    const roots = relayfileInitialSyncPaths([
      "/github/repos/acme/cloud/issues/1543__t/**", // slugged primary (globbed)
      "/github/repos/acme/cloud/issues/1543", // plain companion WITHOUT trailing glob
    ]);
    expect(roots).toEqual(["/github/repos/acme/cloud/issues/1543__t/**"]);
  });

  it("does not duplicate an exact plain issue root with its generated glob companion", () => {
    const roots = relayfileInitialSyncPaths([
      "/github/repos/acme/cloud/issues/1543",
      "/github/repos/acme/cloud/issues/1543/**",
    ]);
    expect(roots).toEqual(["/github/repos/acme/cloud/issues/1543"]);
  });
});

describe("envelope capture (cloud#1841)", () => {
  it("pins buildEnvelope's field set to ENVELOPE_FIELDS (the cross-repo contract anchor)", () => {
    const cron = buildEnvelope({
      workspaceId: "ws-1",
      deploymentId: "dep-1",
      payload: { type: "cron.tick", name: "weekly", cron: "0 9 * * 6" },
    });
    // Always-fields exactly, in any order — no optionals on a bare cron tick.
    expect(Object.keys(cron).sort()).toEqual([...ENVELOPE_FIELDS.always].sort());

    const provider = buildEnvelope({
      workspaceId: "ws-1",
      deploymentId: "dep-1",
      payload: {
        type: "github.pull_request.opened",
        provider: "github",
        eventType: "pull_request.opened",
        deliveryId: "gh-123",
        paths: ["/github/repos/a/b/pulls/1"],
        resource: { action: "opened" },
        summary: { title: "x" },
        channel: "eng",
        messageId: "m-1",
        threadId: "t-1",
      },
      resumeContext: { kind: "resume" } as never,
      harnessSession: {
        id: "8a5bf25b-b7a9-4f9c-88d9-6c93d04a35f1",
        resume: true,
      },
    });
    const allowed = new Set<string>([...ENVELOPE_FIELDS.always, ...ENVELOPE_FIELDS.optional]);
    for (const key of Object.keys(provider)) {
      expect(allowed.has(key), `buildEnvelope emitted undocumented field "${key}" — update ENVELOPE_FIELDS AND workforce's RawGatewayEnvelope contract copy (workforce#189) together`).toBe(true);
    }
    for (const key of ENVELOPE_FIELDS.optional) {
      expect(provider, `expected optional field ${key}`).toHaveProperty(key);
    }
  });

  it("resolves Slack conversation keys from normalized markers before raw events", async () => {
    const { slackConversationKeyFromPayload } = await import("./deployment-trigger-delivery");

    expect(slackConversationKeyFromPayload({
      slackConversation: { channel: { channel: "C123" }, threadTs: "ignored" },
      resource: {
        slackConversation: { channel: "C999", threadTs: "1770000000.000999" },
      },
      event: { channel: "C000", thread_ts: "1770000000.000000" },
    })).toBe("C999:1770000000.000999");

    expect(slackConversationKeyFromPayload({
      resource: {
        slackConversation: { channel: "C234", ackTs: "1770000000.000234" },
      },
      event: { channel: "C000", thread_ts: "1770000000.000000" },
    })).toBe("C234:1770000000.000234");

    expect(slackConversationKeyFromPayload({
      event: { channel: "C345", thread_ts: "1770000000.000345" },
    })).toBe("C345:1770000000.000345");

    expect(slackConversationKeyFromPayload({
      slackConversation: { channel: "C123" },
      event: { channel: "C345" },
    })).toBeNull();
  });

  it("captures the resource fallback non-uniformity as-is (ground truth, not normalized)", () => {
    const withResource = buildEnvelope({
      workspaceId: "ws-1",
      deploymentId: "dep-1",
      payload: { type: "github.x", resource: { only: "resource" }, extra: 1 },
    });
    expect(withResource.resource).toEqual({ only: "resource" });

    const withoutResource = buildEnvelope({
      workspaceId: "ws-1",
      deploymentId: "dep-1",
      payload: { type: "github.x", extra: 1 },
    });
    // Falls back to the WHOLE payload — captured verbatim by design.
    expect(withoutResource.resource).toEqual({ type: "github.x", extra: 1 });
  });

  it("uses cron occurrence identity for stable envelope id and occurredAt", () => {
    const envelope = buildEnvelope({
      workspaceId: "ws-1",
      deploymentId: "dep-1",
      payload: {
        type: "cron.tick",
        scheduleId: "sched_1",
        occurrenceEpoch: 1_781_000_000_000,
        occurrenceId: "occurrence-09",
      },
    });

    expect(envelope.id).toBe("occurrence-09");
    expect(envelope.occurredAt).toBe("2026-06-09T10:13:20.000Z");
  });

  it("envelopeCaptureForStorage is all-or-nothing: stores small, omits oversized, never truncates", () => {
    expect(envelopeCaptureForStorage(null)).toEqual({ envelope: null, omitted: false });
    expect(envelopeCaptureForStorage("")).toEqual({ envelope: null, omitted: false });

    const small = JSON.stringify({ id: "e1", resource: { ok: true } });
    expect(envelopeCaptureForStorage(small)).toEqual({ envelope: small, omitted: false });

    const oversized = JSON.stringify({ id: "e1", resource: "x".repeat(257 * 1024) });
    const captured = envelopeCaptureForStorage(oversized);
    expect(captured.envelope).toBeNull();
    expect(captured.omitted).toBe(true);
    // Never a mangled middle ground.
    expect(captured.envelope === null || captured.envelope === oversized).toBe(true);
  });
});
