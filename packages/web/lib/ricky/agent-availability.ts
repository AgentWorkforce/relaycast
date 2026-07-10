import type { WorkflowFileType } from "@/lib/workflows";
import type { AgentAvailability, RickyAutoFixPolicy, WorkflowRuntimeDescriptor } from "./types";
import { Resource } from "sst";

const SUPPORTED_CLIS = ["claude", "opencode", "codex"] as const;
type SupportedCli = (typeof SUPPORTED_CLIS)[number];
type SupportedProvider = "anthropic" | "opencode" | "openai";

const CLI_TO_PROVIDER: Record<SupportedCli, SupportedProvider> = {
  claude: "anthropic",
  opencode: "opencode",
  codex: "openai",
};

const PROVIDER_TO_CLI: Partial<Record<string, SupportedCli>> = {
  anthropic: "claude",
  opencode: "opencode",
  openai: "codex",
};

function isSupportedCli(value: string): value is SupportedCli {
  return (SUPPORTED_CLIS as readonly string[]).includes(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function extractRequestedClis(input: {
  workflow: string;
  fileType: WorkflowFileType;
}): string[] {
  if (input.fileType === "yaml") {
    try {
      const parsed = JSON.parse(input.workflow) as { agents?: Array<{ cli?: unknown }> };
      return unique((parsed.agents ?? []).map((agent) => String(agent.cli ?? "")));
    } catch {
      return unique(
        [...input.workflow.matchAll(/cli:\s*["']?([a-z][a-z0-9_-]*)/gi)].map((match) => match[1]),
      );
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

function readLinkedSecret(name: string, fallbackEnvVar: string): string | undefined {
  let linked: string | undefined;
  try {
    linked = (Resource as unknown as Record<string, { value?: string } | undefined>)[name]?.value;
  } catch {
    linked = undefined;
  }
  return linked && linked.length > 0 ? linked : process.env[fallbackEnvVar];
}

function credentialEncryptionKey(): string | undefined {
  return readLinkedSecret("CredentialEncryptionKey", "CREDENTIAL_ENCRYPTION_KEY");
}

function resolveRuntimeReason(runtime?: WorkflowRuntimeDescriptor): string | undefined {
  if (!runtime || runtime.id === "daytona" || runtime.id === "worker") {
    return undefined;
  }
  return `Runtime '${runtime.id}' has not declared Ricky CLI capability metadata; credential proxy may still work.`;
}

type ProviderCredentialAvailabilityRow = {
  id?: string | null;
  harness?: string | null;
  status?: string | null;
  credentialExpiresAt?: Date | string | null;
  refreshExhausted?: boolean | null;
  lastAuthenticatedAt?: Date | string | null;
  updatedAt?: Date | string | null;
  createdAt?: Date | string | null;
  lastError?: string | null;
};

function dateMs(value: Date | string | null | undefined): number {
  if (!value) {
    return 0;
  }
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function dateIso(value: Date | string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function credentialPreferenceRank(row: ProviderCredentialAvailabilityRow, now: Date): number {
  if (row.status !== "connected" || row.refreshExhausted) {
    return 2;
  }
  const expiresAtMs = dateMs(row.credentialExpiresAt);
  return expiresAtMs > 0 && expiresAtMs <= now.getTime() ? 1 : 0;
}

function compareCredentialPreference(
  left: ProviderCredentialAvailabilityRow,
  right: ProviderCredentialAvailabilityRow,
  now: Date,
): number {
  const rankDelta = credentialPreferenceRank(left, now) - credentialPreferenceRank(right, now);
  if (rankDelta !== 0) {
    return rankDelta;
  }

  const updatedDelta = dateMs(right.updatedAt) - dateMs(left.updatedAt);
  if (updatedDelta !== 0) {
    return updatedDelta;
  }

  const createdDelta = dateMs(right.createdAt) - dateMs(left.createdAt);
  if (createdDelta !== 0) {
    return createdDelta;
  }

  return String(left.id ?? "").localeCompare(String(right.id ?? ""));
}

function preferredCredentialForCli(
  rows: ProviderCredentialAvailabilityRow[],
  cli: SupportedCli,
  now: Date,
): ProviderCredentialAvailabilityRow | undefined {
  return rows
    .filter((row) => row.harness === cli)
    .sort((left, right) => compareCredentialPreference(left, right, now))[0];
}

export async function resolveAgentAvailability(input: {
  userId: string;
  workspaceId: string;
  workflow: string;
  fileType: WorkflowFileType;
  runtime?: WorkflowRuntimeDescriptor;
  policy: RickyAutoFixPolicy;
}): Promise<AgentAvailability> {
  const requestedClis = unique(extractRequestedClis(input));
  const requestedSupportedClis = requestedClis.filter(isSupportedCli);
  const runtimeReason = resolveRuntimeReason(input.runtime);
  const now = new Date();

  const [{ and, desc, eq, inArray }, { getDb }, { providerCredentials }, { listConnectedProviders }] = await Promise.all([
    import("drizzle-orm"),
    import("@/lib/db"),
    import("@/lib/db/schema"),
    import("@/lib/workflows"),
  ]);

  const rows = await getDb()
    .select()
    .from(providerCredentials)
    .where(
      and(
        eq(providerCredentials.workspaceId, input.workspaceId),
        eq(providerCredentials.userId, input.userId),
        inArray(providerCredentials.harness, [...SUPPORTED_CLIS]),
      ),
    )
    .orderBy(
      desc(providerCredentials.updatedAt),
      desc(providerCredentials.createdAt),
      desc(providerCredentials.id),
    )
    .catch(() => []);

  let connectedProviders: string[] = [];
  const encryptionKey = credentialEncryptionKey();
  if (encryptionKey) {
    try {
      connectedProviders = await listConnectedProviders(input.userId, encryptionKey);
    } catch {
      connectedProviders = [];
    }
  }

  const byCli = new Map<SupportedCli, AgentAvailability["subscriptionAgents"][number]>();
  for (const cli of SUPPORTED_CLIS) {
    const provider = CLI_TO_PROVIDER[cli];
    const cloud = preferredCredentialForCli(rows, cli, now);
    if (cloud) {
      const expiresAtMs = dateMs(cloud.credentialExpiresAt);
      const expired = expiresAtMs > 0 && expiresAtMs <= now.getTime();
      byCli.set(cli, {
        cli,
        provider,
        source: "cloud_agents",
        status:
          cloud.status !== "connected"
            ? "unhealthy"
            : cloud.refreshExhausted
            ? "unhealthy"
            : expired
            ? "expired"
            : runtimeReason
            ? "unsupported"
            : "usable",
        credentialExpiresAt: dateIso(cloud.credentialExpiresAt),
        lastAuthenticatedAt: dateIso(cloud.lastAuthenticatedAt),
        reason: cloud.lastError ?? runtimeReason,
      });
      continue;
    }

    if (connectedProviders.includes(provider)) {
      byCli.set(cli, {
        cli,
        provider,
        source: "cli_credentials",
        status: runtimeReason ? "unsupported" : "usable",
        reason: runtimeReason,
      });
      continue;
    }

    byCli.set(cli, {
      cli,
      provider,
      source: "cli_credentials",
      status: "missing",
      reason: "No cloud agent or encrypted CLI credential metadata found.",
    });
  }

  const credentialProxyUrl = process.env.CREDENTIAL_PROXY_URL ?? process.env.RELAY_LLM_PROXY_URL;
  const proxyJwtSecret = readLinkedSecret("CredentialProxyJwtSecret", "CREDENTIAL_PROXY_JWT_SECRET");
  const configuredProxyToken = process.env.CREDENTIAL_PROXY_TOKEN ?? process.env.RELAY_LLM_PROXY_TOKEN;
  const openRouterModel = process.env.RICKY_OPENROUTER_MODEL ?? "openrouter/auto";
  const openRouterFallback: AgentAvailability["openRouterFallback"] = !input.policy.allowOpenRouterFallback
    ? {
        status: "disabled",
        provider: "openrouter",
        model: openRouterModel,
        reason: "Disabled by Ricky auto-fix policy.",
      }
    : credentialProxyUrl && (proxyJwtSecret || configuredProxyToken)
    ? {
        status: "usable",
        provider: "openrouter",
        model: openRouterModel,
      }
    : {
        status: "missing",
        provider: "openrouter",
        model: openRouterModel,
        reason: "Credential proxy URL and token/JWT secret are required for OpenRouter fallback.",
      };

  const subscriptionAgents = [...byCli.values()].filter((agent) => {
    return requestedSupportedClis.length === 0 || requestedSupportedClis.includes(agent.cli);
  });

  return {
    checkedAt: new Date().toISOString(),
    workspaceId: input.workspaceId,
    userId: input.userId,
    requestedClis,
    subscriptionAgents,
    workforcePersona: resolveWorkforcePersona(input.policy),
    openRouterFallback,
  };
}

function resolveWorkforcePersona(policy: RickyAutoFixPolicy): AgentAvailability["workforcePersona"] {
  if (!policy.preferWorkforcePersona) {
    return {
      status: "missing",
      reason: "Disabled by Ricky auto-fix policy.",
    };
  }

  const personaId = process.env.RICKY_WORKFORCE_PERSONA_ID;
  if (!personaId) {
    return {
      status: "missing",
      reason: "No Ricky Workforce persona resolver is configured for this cloud stage.",
    };
  }

  return {
    status: "usable",
    personaId,
    tier: process.env.RICKY_WORKFORCE_PERSONA_TIER ?? "cloud",
    harness: process.env.RICKY_WORKFORCE_PERSONA_HARNESS ?? "workforce",
    model: process.env.RICKY_WORKFORCE_PERSONA_MODEL ?? "configured",
    selectedIntent: "workflow_repair",
  };
}

export function resolveAgentAvailabilityFromSnapshot(input: {
  workspaceId: string;
  userId: string;
  requestedClis: Array<"claude" | "opencode" | "codex">;
  checkedAt: string;
  providerCredentials?: Array<{
    cli: "claude" | "opencode" | "codex";
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
    supportedClis?: Array<"claude" | "opencode" | "codex">;
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

    const cloud = input.providerCredentials?.find((agent) => agent.cli === cli);
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
