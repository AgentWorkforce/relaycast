type AgentsMdIntegration = {
  source?: { kind?: string; name?: string } | null;
  name?: string | null;
};

export type AgentsMdInput = {
  agent: { id: string; deployedName: string };
  persona: Record<string, unknown> & {
    id: string;
    version?: string | number;
    harness?: string;
    model?: string;
    systemPrompt?: string;
  };
  integrations: Record<string, AgentsMdIntegration | null | undefined>;
  relaycast: {
    workspace: string;
    agentName: string;
    defaultWorkspaceId: string;
  };
  schedules: Array<{ name: string; cron: string; tz: string }>;
};

function line(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function redactSecrets(value: string): string {
  return value.replace(
    /\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*)\s*=\s*([^\s`'"]+)/gi,
    "$1=[redacted]",
  );
}

function renderIntegrations(integrations: AgentsMdInput["integrations"]): string {
  const entries = Object.entries(integrations).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return "- none";
  }
  return entries
    .map(([provider, config]) => {
      const source = config?.source?.kind ?? "deployer_user";
      const name = config?.source?.name ?? config?.name ?? "default";
      return `- ${provider}: ${name} (${source})`;
    })
    .join("\n");
}

function renderSchedules(schedules: AgentsMdInput["schedules"]): string {
  if (schedules.length === 0) {
    return "- none";
  }
  return schedules
    .map((schedule) => `- ${schedule.name}: ${schedule.cron} ${schedule.tz}`)
    .join("\n");
}

export function renderAgentsMd(input: AgentsMdInput): string {
  return [
    `# Agent: ${input.agent.deployedName}`,
    "",
    `Agent ID: ${input.agent.id}`,
    `Persona: ${input.persona.id} v${line(input.persona.version) || "1"}`,
    `Harness: ${line(input.persona.harness)}`,
    `Model: ${line(input.persona.model)}`,
    "",
    "## System prompt",
    "",
    redactSecrets(line(input.persona.systemPrompt)),
    "",
    "## Integrations resolved at deploy",
    "",
    renderIntegrations(input.integrations),
    "",
    "## Schedules",
    "",
    renderSchedules(input.schedules),
    "",
    "## Relaycast environment",
    "",
    `- workspace: ${input.relaycast.workspace}`,
    `- agent name: ${input.relaycast.agentName}`,
    `- default workspace id: ${input.relaycast.defaultWorkspaceId}`,
    "",
    "## Loud holes",
    "",
    "- Memory is wired via /memory/* relayfile paths.",
    "- Schedules fire via the cloud's deployment ticks endpoint.",
    "",
  ].join("\n");
}
