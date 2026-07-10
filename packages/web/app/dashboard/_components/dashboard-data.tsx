"use client";

import { createContext, useContext, useEffect, useState, useTransition } from "react";
import type { ReactNode } from "react";
import type { AuthContext } from "@/lib/auth/types";
import { toAppPath } from "@/lib/app-path";

export type SessionState =
  | { authenticated: false }
  | ({ authenticated: true } & AuthContext);

export type WorkflowRunRickyAttempt = {
  attempt: number;
  workflowRunId: string;
  role: string;
  repairMode: string;
  status: string;
  repairSummary?: string;
  repairAgent?: Record<string, unknown>;
};

export type WorkflowRunRickyGate = {
  id: string;
  gateType: string;
  reason: string;
  prompt: string;
  status: string;
  createdAt: string;
};

export type WorkflowRunRickySupervisor = {
  id: string;
  status: string;
  currentAttempt: number;
  maxAttempts: number;
  latestDiagnosis?: Record<string, unknown>;
  attempts: WorkflowRunRickyAttempt[];
  gates: WorkflowRunRickyGate[];
};

export type WorkflowRun = {
  runId: string;
  sandboxId: string | null;
  dispatchType?: string;
  userId: string;
  workspaceId: string;
  workflow: string;
  fileType: "yaml" | "ts" | "py";
  status: string;
  createdAt: string;
  updatedAt: string;
  result?: unknown;
  error?: string;
  rickyRun?: WorkflowRunRickySupervisor;
};

export type WorkflowSchedule = {
  id: string;
  relaycronScheduleId: string;
  userId: string;
  workspaceId: string;
  organizationId: string;
  name: string;
  description: string | null;
  scheduleType: "once" | "cron";
  cronExpression: string | null;
  scheduledAt: string | null;
  timezone: string;
  status: string;
  lastTriggeredRunId: string | null;
  lastTriggeredAt: string | null;
  lastTriggerStatus: string | null;
  lastTriggerError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CloudAgent = {
  id: string;
  displayName: string;
  harness: string;
  modelProvider: string;
  authType: string;
  label: string | null;
  accountEmail: string | null;
  isActive: boolean;
  defaultModel: string | null;
  status: string;
  credentialStoredAt: string | null;
  lastAuthenticatedAt: string | null;
  lastUsedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  usage?: AccountUsageSnapshot | null;
};

export type AccountUsageWindow = {
  id: string;
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetAt: string | null;
  windowMinutes: number | null;
};

export type AccountUsageSnapshot = {
  provider: string;
  status: "available" | "unsupported" | "unavailable" | "error";
  source: "claude-oauth" | "codex-oauth" | "none";
  fetchedAt: string;
  windows: AccountUsageWindow[];
  credits?: {
    balance: number | null;
    unlimited: boolean;
  };
  plan?: string | null;
  error?: string;
};

export type DeployedAgent = {
  agentId: string;
  personaId: string;
  deployedName: string;
  status: string;
  createdAt: string;
  lastUsedAt: string | null;
  lastFiredAt: string | null;
  lastCompletedAt: string | null;
  lastRunStatus: string | null;
  lastError: string | null;
  runCount: number;
  scheduleIds: string[];
  scheduleSpecs: Array<{ id?: string; cronExpression: string; timezone: string; name?: string }>;
  inputValues: Record<string, string>;
  inputSpecs: Record<string, { picker?: { provider: string; resource: string } }>;
  imageUrl: string | null;
  personaDescription: string | null;
  deployedByUserId: string;
};

const SECRET_INPUT_KEY_PATTERN = /(_KEY|_TOKEN|_SECRET|PASSWORD|_PAT|APIKEY)/i;

export function getAgentInputEntries(inputValues: Record<string, string> | null | undefined): Array<[string, string]> {
  if (!inputValues) return [];
  return Object.entries(inputValues).filter(([key]) => key.trim().length > 0);
}

export function formatAgentInputValue(key: string, value: string): string {
  if (SECRET_INPUT_KEY_PATTERN.test(key)) {
    return "•••• set";
  }
  return value.length > 0 ? value : "Not set";
}

export type DeploymentFire = {
  id: string;
  deploymentId: string;
  agentId: string;
  eventSource: string;
  sandboxId: string | null;
  sandboxName: string | null;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  exitCode: number | null;
  cleanupStatus: Record<string, unknown>;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number;
  status: string;
  error: string | null;
  summary: string | null;
  compressedAt: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
};

export type DeploymentLogEntry = {
  id: string;
  timestamp: string;
  level: "debug" | "info" | "warn" | "error" | string;
  source: string;
  message: string;
  durationMs: number | null;
  stream: string;
  payload: Record<string, unknown>;
};

export type DeploymentFireDetail = DeploymentFire & {
  stdout: string;
  stderr: string;
  mountLogTail: string;
  entries?: DeploymentLogEntry[];
};

export type PendingInvite = {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  createdAt: string;
  invitedByName: string | null;
};

export type ConnectCommand = {
  provider: string;
  label: string;
  cli: string;
  note: string;
  command: string;
};

const CONNECT_COMMANDS: ConnectCommand[] = [
  {
    provider: "anthropic",
    label: "Claude",
    cli: "claude",
    note: "Authenticates Claude Code harnesses.",
    command: "npx agent-relay cloud connect anthropic",
  },
  {
    provider: "openai",
    label: "Codex",
    cli: "codex",
    note: "Authenticates Codex and other OpenAI-backed harnesses.",
    command: "npx agent-relay cloud connect openai",
  },
  {
    provider: "google",
    label: "Gemini",
    cli: "gemini",
    note: "Authenticates Gemini CLI harnesses.",
    command: "npx agent-relay cloud connect google",
  },
  {
    provider: "cursor",
    label: "Cursor",
    cli: "agent",
    note: "Authenticates Cursor Agent harnesses.",
    command: "npx agent-relay cloud connect cursor",
  },
  {
    provider: "opencode",
    label: "OpenCode",
    cli: "opencode",
    note: "Authenticates OpenCode harnesses.",
    command: "npx agent-relay cloud connect opencode",
  },
  {
    provider: "droid",
    label: "Droid",
    cli: "droid",
    note: "Authenticates Droid harnesses.",
    command: "npx agent-relay cloud connect droid",
  },
];

type DashboardContextValue = {
  session: SessionState | null;
  sessionLoading: boolean;
  authSession: ({ authenticated: true } & AuthContext) | null;
  authenticated: boolean;
  loadingData: boolean;
  authPending: boolean;
  runs: WorkflowRun[];
  schedules: WorkflowSchedule[];
  agents: CloudAgent[];
  deploymentAgents: DeployedAgent[];
  pendingInvites: PendingInvite[];
  organizationRuns: WorkflowRun[];
  organizationSchedules: WorkflowSchedule[];
  totalRuns: number;
  totalSchedules: number;
  activeSchedules: number;
  activeRuns: number;
  failedRuns: number;
  healthyAgents: number;
  latestRun: WorkflowRun | null;
  connectCommands: ConnectCommand[];
  switchWorkspace: (workspaceId: string) => void;
  logout: () => void;
  refreshInvites: () => Promise<void>;
  cancelInvite: (inviteId: string) => Promise<void>;
  activateCloudAgent: (agentId: string) => Promise<void>;
  deleteCloudAgent: (agentId: string) => Promise<void>;
};

const DashboardContext = createContext<DashboardContextValue | null>(null);

async function getJson<T>(url: string): Promise<T | null> {
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "include",
  });

  if (!response.ok) {
    return null;
  }

  return (await response.json().catch(() => null)) as T | null;
}

function parseWorkflowJson(workflow: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(workflow);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Workflow may not be JSON.
  }

  return null;
}

export function formatTimestamp(value: string | null | undefined) {
  if (!value) {
    return "Never";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }

  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatRelative(value: string | null | undefined) {
  if (!value) {
    return "No activity yet";
  }

  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    return "Unknown";
  }

  const deltaMs = timestamp - Date.now();
  const deltaMinutes = Math.round(deltaMs / 60_000);

  if (Math.abs(deltaMinutes) < 1) {
    return "Just now";
  }

  if (Math.abs(deltaMinutes) < 60) {
    return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
      deltaMinutes,
      "minute",
    );
  }

  const deltaHours = Math.round(deltaMinutes / 60);
  if (Math.abs(deltaHours) < 24) {
    return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
      deltaHours,
      "hour",
    );
  }

  const deltaDays = Math.round(deltaHours / 24);
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
    deltaDays,
    "day",
  );
}

export function trimText(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1)}…`;
}

export function getWorkflowName(run: WorkflowRun) {
  const parsed = parseWorkflowJson(run.workflow);
  if (parsed && typeof parsed.name === "string" && parsed.name) {
    return parsed.name;
  }

  // YAML or TS config-object: `name: "value"` at the start of a line.
  // Anchoring to line start avoids matching `name:` inside prose ("your
  // agent name:") or nested agent entries before the top-level name.
  const yamlOrConfigName = run.workflow
    .match(/^\s*name:\s*["']?([^\n"']+)/im)?.[1]
    ?.trim();
  if (yamlOrConfigName) {
    return yamlOrConfigName;
  }

  // TS WorkflowBuilder fluent APIs:
  //   workflow('name')
  //   WorkflowBuilder.create('name')
  //   new WorkflowBuilder('name')
  const builderName = run.workflow
    .match(
      /(?:\bworkflow|\bWorkflowBuilder(?:\.create)?|\bnew\s+WorkflowBuilder)\s*\(\s*["'`]([^"'`]+)["'`]/,
    )?.[1]
    ?.trim();
  if (builderName) {
    return builderName;
  }

  const exportName =
    run.workflow.match(/(?:const|let|var)\s+name\s*=\s*["'`]([^"'`]+)["'`]/)?.[1];
  if (exportName) {
    return exportName.trim();
  }

  // Fallback: first non-comment, non-empty line. Previously this surfaced
  // JSDoc openers ("/**") as the workflow name in the dashboard because TS
  // workflows commonly start with a doc comment. Skip common comment forms
  // so the fallback picks a real line of code if the builder regexes miss.
  const firstMeaningfulLine = run.workflow
    .split("\n")
    .map((line) => line.trim())
    .find(
      (line) =>
        line.length > 0 &&
        !line.startsWith("/*") &&
        !line.startsWith("*/") &&
        !line.startsWith("*") &&
        !line.startsWith("//") &&
        !line.startsWith("#"),
    );
  return firstMeaningfulLine
    ? trimText(firstMeaningfulLine, 40)
    : "Untitled workflow";
}

export function getWorkflowDetail(run: WorkflowRun) {
  if (run.error) {
    return trimText(run.error, 120);
  }

  if (typeof run.result === "string") {
    return trimText(run.result, 120);
  }

  if (
    run.result &&
    typeof run.result === "object" &&
    "output" in run.result &&
    typeof run.result.output === "string"
  ) {
    return trimText(run.result.output, 120);
  }

  const parsed = parseWorkflowJson(run.workflow);
  if (parsed && typeof parsed.description === "string" && parsed.description) {
    return trimText(parsed.description, 120);
  }

  return null;
}

export function getRunBadgeVariant(status: string) {
  const normalized = status.toLowerCase();

  if (normalized === "completed" || normalized === "success") {
    return "success" as const;
  }

  if (normalized === "running" || normalized === "pending") {
    return "info" as const;
  }

  if (normalized === "failed" || normalized === "error") {
    return "danger" as const;
  }

  return "default" as const;
}

export function getAgentBadgeVariant(status: string) {
  const normalized = status.toLowerCase();

  if (["ready", "active", "connected", "authenticated"].includes(normalized)) {
    return "success" as const;
  }

  if (["authorizing", "pending", "starting"].includes(normalized)) {
    return "warning" as const;
  }

  if (["failed", "error", "revoked", "expired"].includes(normalized)) {
    return "danger" as const;
  }

  return "default" as const;
}

function isActiveRun(status: string) {
  const normalized = status.toLowerCase();
  return normalized === "running" || normalized === "pending";
}

function isHealthyAgent(status: string) {
  return ["ready", "active", "connected", "authenticated"].includes(status.toLowerCase());
}

function normalizeHarnessToProvider(harness: string) {
  const value = harness.toLowerCase();

  if (value === "claude") {
    return "anthropic";
  }
  if (value === "codex" || value === "aider") {
    return "openai";
  }
  if (value === "gemini") {
    return "google";
  }
  if (value === "agent") {
    return "cursor";
  }

  return value;
}

export function getConnectCommands(agents: CloudAgent[]) {
  const prioritized = new Set<string>();

  for (const agent of agents) {
    const provider = normalizeHarnessToProvider(agent.harness);
    if (CONNECT_COMMANDS.some((command) => command.provider === provider)) {
      prioritized.add(provider);
    }
  }

  const orderedProviders = [...prioritized];
  for (const command of CONNECT_COMMANDS) {
    if (!prioritized.has(command.provider)) {
      orderedProviders.push(command.provider);
    }
  }

  return orderedProviders
    .map((provider) => CONNECT_COMMANDS.find((command) => command.provider === provider) ?? null)
    .filter((command): command is ConnectCommand => command !== null);
}

export function getUserInitials(name: string | null | undefined, email: string | null | undefined) {
  const source = name?.trim() || email?.trim() || "User";
  const words = source
    .replace(/@.*$/, "")
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) {
    return "U";
  }

  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }

  return `${words[0][0] ?? ""}${words[1][0] ?? ""}`.toUpperCase();
}

async function fetchInvites() {
  const data = await getJson<{ invites?: PendingInvite[] }>(toAppPath("/api/v1/invites"));
  return Array.isArray(data?.invites) ? data.invites : [];
}

export function DashboardProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [session, setSession] = useState<SessionState | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [schedules, setSchedules] = useState<WorkflowSchedule[]>([]);
  const [agents, setAgents] = useState<CloudAgent[]>([]);
  const [deploymentAgents, setDeploymentAgents] = useState<DeployedAgent[]>([]);
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  const [authPending, startTransition] = useTransition();
  const authSession = session?.authenticated === true ? session : null;
  const workspaceId = authSession?.currentWorkspace.id ?? null;

  useEffect(() => {
    let active = true;

    // Dev bypass: use a fully-mocked, backend-less session. This is opt-in via
    // NEXT_PUBLIC_DEV_MOCK_SESSION so it does NOT hijack the real local-dev flow
    // (real Postgres + the /api/auth/dev-login session). Without the explicit
    // flag we fall through to the real /api/auth/session below, otherwise every
    // workspace-scoped API call would use the bogus "dev-workspace-id" and 403.
    const isDevBypass =
      process.env.NEXT_PUBLIC_DEV_MOCK_SESSION === "true" &&
      typeof window !== "undefined" &&
      !window.location.hostname.includes("cloud.agentrelay.com");

    if (isDevBypass) {
      if (active) {
        setSession({
          authenticated: true,
          user: {
            id: "dev-user-id",
            email: "dev@localhost",
            name: "Dev User",
            avatarUrl: null,
          },
          organizations: [
            {
              id: "dev-org-id",
              slug: "dev-org",
              name: "Dev Organization",
              role: "owner",
              status: "active",
            },
          ],
          currentOrganization: {
            id: "dev-org-id",
            slug: "dev-org",
            name: "Dev Organization",
            role: "owner",
            status: "active",
          },
          workspaces: [
            {
              id: "dev-workspace-id",
              organization_id: "dev-org-id",
              slug: "dev-workspace",
              name: "Dev Workspace",
            },
          ],
          currentWorkspace: {
            id: "dev-workspace-id",
            organization_id: "dev-org-id",
            slug: "dev-workspace",
            name: "Dev Workspace",
          },
        });
      }
      return () => {
        active = false;
      };
    }

    getJson<SessionState>(toAppPath("/api/auth/session"))
      .then((payload) => {
        if (active) {
          setSession(payload ?? { authenticated: false });
        }
      })
      .catch(() => {
        if (active) {
          setSession({ authenticated: false });
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!workspaceId) {
      setRuns([]);
      setSchedules([]);
      setAgents([]);
      setDeploymentAgents([]);
      setPendingInvites([]);
      setLoadingData(false);
      return;
    }

    let active = true;

    const loadData = async (isInitial: boolean) => {
      if (isInitial) {
        setLoadingData(true);
      }

      const [runsPayload, schedulesPayload, agentsPayload, deploymentAgentsPayload] = await Promise.all([
        getJson<{ runs?: WorkflowRun[] }>(toAppPath("/api/v1/workflows/runs")),
        getJson<{ schedules?: WorkflowSchedule[] }>(toAppPath("/api/v1/workflows/schedules")),
        getJson<{ agents?: CloudAgent[] }>(toAppPath("/api/v1/cloud-agents?usage=1")),
        getJson<{ agents?: DeployedAgent[] }>(
          toAppPath(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/deployments`),
        ),
      ]);

      if (!active) {
        return;
      }

      if (Array.isArray(runsPayload?.runs)) {
        setRuns(runsPayload.runs);
      }
      if (Array.isArray(schedulesPayload?.schedules)) {
        setSchedules(schedulesPayload.schedules);
      }
      if (Array.isArray(agentsPayload?.agents)) {
        setAgents(agentsPayload.agents);
      }
      if (Array.isArray(deploymentAgentsPayload?.agents)) {
        setDeploymentAgents(
          deploymentAgentsPayload.agents.map((agent) => ({
            ...agent,
            lastFiredAt: agent.lastFiredAt ?? null,
            lastCompletedAt: agent.lastCompletedAt ?? null,
            lastRunStatus: agent.lastRunStatus ?? null,
            lastError: agent.lastError ?? null,
            runCount: Number(agent.runCount ?? 0),
            scheduleIds: agent.scheduleIds ?? [],
            scheduleSpecs: agent.scheduleSpecs ?? [],
            inputValues: agent.inputValues ?? {},
            inputSpecs: agent.inputSpecs ?? {},
            imageUrl: agent.imageUrl ?? null,
            personaDescription: agent.personaDescription ?? null,
          })),
        );
      }

      if (isInitial) {
        setLoadingData(false);
      }
    };

    const loadInvites = async () => {
      const invites = await fetchInvites();
      if (active) {
        setPendingInvites(invites);
      }
    };

    loadData(true).catch(() => {
      if (active) {
        setRuns([]);
        setSchedules([]);
        setAgents([]);
        setDeploymentAgents([]);
        setLoadingData(false);
      }
    });
    loadInvites().catch(() => {
      if (active) {
        setPendingInvites([]);
      }
    });

    const intervalId = window.setInterval(() => {
      loadData(false).catch(() => {});
    }, 10_000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [workspaceId]);

  const refreshInvites = async () => {
    if (!authSession) {
      setPendingInvites([]);
      return;
    }

    const invites = await fetchInvites();
    setPendingInvites(invites);
  };

  const cancelInvite = async (inviteId: string) => {
    await fetch(toAppPath(`/api/v1/invites/${inviteId}`), {
      method: "DELETE",
      credentials: "include",
    });
    await refreshInvites();
  };

  const activateCloudAgent = async (agentId: string) => {
    const target = agents.find((agent) => agent.id === agentId);
    if (!target || target.isActive) {
      return;
    }
    // Optimistic: one active per provider group.
    setAgents((current) =>
      current.map((agent) =>
        agent.modelProvider === target.modelProvider
          ? { ...agent, isActive: agent.id === agentId }
          : agent,
      ),
    );
    const response = await fetch(
      toAppPath(`/api/v1/cloud-agents/${encodeURIComponent(agentId)}/activate`),
      { method: "POST", credentials: "include" },
    ).catch(() => null);
    if (!response?.ok) {
      // Roll back to server truth on failure.
      const data = await getJson<{ agents?: CloudAgent[] }>(toAppPath("/api/v1/cloud-agents?usage=1"));
      if (Array.isArray(data?.agents)) {
        setAgents(data.agents);
      }
    }
  };

  const deleteCloudAgent = async (agentId: string) => {
    const target = agents.find((agent) => agent.id === agentId);
    if (!target) {
      return;
    }
    const previousAgents = agents;
    // Optimistic removal; the DELETE endpoint is scoped to the signed-in
    // user + workspace, so a foreign id can only 404 (handled by rollback).
    setAgents((current) => current.filter((agent) => agent.id !== agentId));
    const response = await fetch(
      toAppPath(`/api/v1/cloud-agents/${encodeURIComponent(agentId)}`),
      { method: "DELETE", credentials: "include" },
    ).catch(() => null);
    if (response?.ok) {
      const data = await getJson<{ agents?: CloudAgent[] }>(toAppPath("/api/v1/cloud-agents?usage=1"));
      if (Array.isArray(data?.agents)) {
        setAgents(data.agents);
      }
      return;
    }

    // Roll back to server truth on failure.
    try {
      const data = await getJson<{ agents?: CloudAgent[] }>(toAppPath("/api/v1/cloud-agents?usage=1"));
      if (Array.isArray(data?.agents)) {
        setAgents(data.agents);
        return;
      }
    } catch {
      // Fall through to the local rollback below.
    }
    setAgents(previousAgents);
  };

  const switchWorkspace = (nextWorkspaceId: string) => {
    if (!authSession || nextWorkspaceId === authSession.currentWorkspace.id) {
      return;
    }

    setLoadingData(true);
    startTransition(async () => {
      const response = await fetch(toAppPath("/api/auth/workspace"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ workspaceId: nextWorkspaceId }),
      });
      const payload = (await response.json().catch(() => null)) as SessionState | null;
      if (response.ok && payload?.authenticated) {
        setSession(payload);
        return;
      }
      setLoadingData(false);
    });
  };

  const logout = () => {
    startTransition(async () => {
      await fetch(toAppPath("/api/auth/logout"), {
        method: "POST",
        credentials: "include",
      }).catch(() => {});
      setSession({ authenticated: false });
      setRuns([]);
      setSchedules([]);
      setAgents([]);
      setDeploymentAgents([]);
      setPendingInvites([]);
      setLoadingData(false);
    });
  };

  const organizationWorkspaceIds = new Set(
    authSession
      ? authSession.workspaces
          .filter((workspace) => workspace.organization_id === authSession.currentOrganization.id)
          .map((workspace) => workspace.id)
      : [],
  );
  const organizationRuns = authSession
    ? runs.filter((run) => organizationWorkspaceIds.has(run.workspaceId))
    : [];
  const organizationSchedules = authSession
    ? schedules.filter((schedule) => organizationWorkspaceIds.has(schedule.workspaceId))
    : [];
  const totalRuns = organizationRuns.length;
  const totalSchedules = organizationSchedules.length;
  const activeSchedules = organizationSchedules.filter(
    (schedule) => schedule.status.toLowerCase() === "active",
  ).length;
  const activeRuns = organizationRuns.filter((run) => isActiveRun(run.status)).length;
  const failedRuns = organizationRuns.filter((run) => run.status.toLowerCase() === "failed").length;
  const healthyAgents = agents.filter((agent) => isHealthyAgent(agent.status)).length;
  const latestRun = organizationRuns[0] ?? null;

  return (
    <DashboardContext.Provider
      value={{
        session,
        sessionLoading: session === null,
        authSession,
        authenticated: authSession !== null,
        loadingData,
        authPending,
        runs,
        schedules,
        agents,
        deploymentAgents,
        pendingInvites,
        organizationRuns,
        organizationSchedules,
        totalRuns,
        totalSchedules,
        activeSchedules,
        activeRuns,
        failedRuns,
        healthyAgents,
        latestRun,
        connectCommands: getConnectCommands(agents),
        switchWorkspace,
        logout,
        refreshInvites,
        cancelInvite,
        activateCloudAgent,
        deleteCloudAgent,
      }}
    >
      {children}
    </DashboardContext.Provider>
  );
}

export function useDashboard() {
  const context = useContext(DashboardContext);

  if (!context) {
    throw new Error("useDashboard must be used within DashboardProvider");
  }

  return context;
}
