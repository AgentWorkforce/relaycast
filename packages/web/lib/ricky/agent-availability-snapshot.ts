import type { AgentAvailability, RickyAutoFixPolicy } from "./types";

const CLI_TO_PROVIDER = {
  claude: "anthropic",
  opencode: "opencode",
  codex: "openai",
} as const;

type SupportedCli = keyof typeof CLI_TO_PROVIDER;

export function extractRequestedClisFromWorkflow(input: {
  workflow: string;
  fileType: "yaml" | "ts" | "py";
}): string[] {
  if (input.fileType === "yaml") {
    try {
      const parsed = JSON.parse(input.workflow) as { agents?: Array<{ cli?: unknown }> };
      return Array.from(new Set((parsed.agents ?? []).map((agent) => String(agent.cli ?? "")).filter(Boolean)));
    } catch {
      return Array.from(new Set([...input.workflow.matchAll(/cli:\s*["']?([a-z][a-z0-9_-]*)/gi)].map((match) => match[1])));
    }
  }

  const clis = new Set<string>();
  const patterns = [
    /cli:\s*["']([a-z][a-z0-9_-]*)["']/gi,
    /cli\s*=\s*["']([a-z][a-z0-9_-]*)["']/gi,
    /(?:claude|codex|opencode)/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(input.workflow)) !== null) {
      clis.add((match[1] ?? match[0]).toLowerCase());
    }
  }
  return [...clis];
}

export function resolveAgentAvailabilityFromSnapshot(input: {
  workspaceId: string;
  userId: string;
  requestedClis: SupportedCli[];
  checkedAt: string;
  cloudAgents?: Array<{
    cli: SupportedCli;
    status: "connected" | "missing" | "unhealthy" | "disconnected";
    credentialExpiresAt?: string;
    lastAuthenticatedAt?: string;
    reason?: string;
  }>;
  cliCredentials?: Array<{
    provider: "anthropic" | "opencode" | "openai";
    status: "connected" | "missing" | "unhealthy";
    credentialExpiresAt?: string;
    lastAuthenticatedAt?: string;
    reason?: string;
  }>;
  runtime?: {
    supportedClis?: SupportedCli[];
    unsupportedReason?: string;
  };
  workforcePersona?: AgentAvailability["workforcePersona"];
  openRouter?: {
    proxyUrl?: string;
    jwtSecret?: string;
    upstreamKey?: string;
    model?: string;
    healthy?: boolean;
    reason?: string;
  };
  policy?: Partial<RickyAutoFixPolicy>;
}): AgentAvailability {
  const nowMs = Date.parse(input.checkedAt);
  const requestedClis = Array.from(new Set(input.requestedClis));
  const subscriptionAgents = requestedClis.map<AgentAvailability["subscriptionAgents"][number]>((cli) => {
    const provider = CLI_TO_PROVIDER[cli];
    if (input.runtime?.supportedClis && !input.runtime.supportedClis.includes(cli)) {
      return {
        cli,
        provider,
        source: "worker",
        status: "unsupported",
        reason: input.runtime.unsupportedReason ?? `${cli} is not installed in the selected runtime`,
      };
    }

    const cloud = input.cloudAgents?.find((agent) => agent.cli === cli);
    if (cloud?.status === "connected") {
      const expired = cloud.credentialExpiresAt ? Date.parse(cloud.credentialExpiresAt) <= nowMs : false;
      return {
        cli,
        provider,
        source: "cloud_agents",
        status: expired ? "expired" : "usable",
        credentialExpiresAt: cloud.credentialExpiresAt,
        lastAuthenticatedAt: cloud.lastAuthenticatedAt,
        reason: expired ? "cloud agent credential expired" : undefined,
      };
    }
    if (cloud?.status === "unhealthy") {
      return {
        cli,
        provider,
        source: "cloud_agents",
        status: "unhealthy",
        reason: cloud.reason ?? "cloud agent health check failed",
      };
    }

    const credential = input.cliCredentials?.find((item) => item.provider === provider);
    if (credential?.status === "connected") {
      const expired = credential.credentialExpiresAt
        ? Date.parse(credential.credentialExpiresAt) <= nowMs
        : false;
      return {
        cli,
        provider,
        source: "cli_credentials",
        status: expired ? "expired" : "usable",
        credentialExpiresAt: credential.credentialExpiresAt,
        lastAuthenticatedAt: credential.lastAuthenticatedAt,
        reason: expired ? "CLI credential expired" : undefined,
      };
    }
    if (credential?.status === "unhealthy") {
      return {
        cli,
        provider,
        source: "cli_credentials",
        status: "unhealthy",
        reason: credential.reason ?? "CLI credential health check failed",
      };
    }

    return {
      cli,
      provider,
      source: cloud ? "cloud_agents" : "cli_credentials",
      status: "missing",
      reason: `no usable ${cli} subscription-backed agent found`,
    };
  });

  const openRouterModel = input.openRouter?.model ?? "openrouter/auto";
  const openRouterFallback: AgentAvailability["openRouterFallback"] =
    input.policy?.allowOpenRouterFallback === false
      ? {
          status: "disabled",
          provider: "openrouter",
          model: openRouterModel,
          reason: "OpenRouter fallback disabled by policy",
        }
      : !input.openRouter?.proxyUrl || !input.openRouter.jwtSecret || !input.openRouter.upstreamKey
      ? {
          status: "missing",
          provider: "openrouter",
          model: openRouterModel,
          reason: "credential proxy URL, JWT secret, and OpenRouter upstream key are required",
        }
      : input.openRouter.healthy === false
      ? {
          status: "unhealthy",
          provider: "openrouter",
          model: openRouterModel,
          reason: input.openRouter.reason ?? "OpenRouter credential proxy readiness check failed",
        }
      : {
          status: "usable",
          provider: "openrouter",
          model: openRouterModel,
        };

  return {
    checkedAt: input.checkedAt,
    workspaceId: input.workspaceId,
    userId: input.userId,
    requestedClis,
    subscriptionAgents,
    workforcePersona: input.workforcePersona,
    openRouterFallback,
  };
}
