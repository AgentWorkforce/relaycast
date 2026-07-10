import { deploymentPersonaSpec } from "./agent-spec.js";

type CapabilityValue = true | { enabled?: unknown };
export type CapabilityName =
  | "review"
  | "conflictAutofix"
  | "conflictResolve"
  | "teamSolve"
  | "conversational";

type CapabilityAlias =
  | { kind: "intent"; value: string }
  | { kind: "capability"; key: string };

export type TeamSolveCapabilityConfig = {
  maxMembers: number;
  tokenBudget: number;
  timeBudgetSeconds: number;
  roles: string[];
};

export type ConversationalCapabilityConfig = {
  enabled: boolean;
  defaultResponder: boolean;
  channels: string[];
  identity?: {
    username?: string;
    iconUrl?: string;
  };
};

type CapabilityConfigMap = {
  review: Record<string, unknown> | null;
  conflictAutofix: Record<string, unknown> | null;
  conflictResolve: Record<string, unknown> | null;
  teamSolve: TeamSolveCapabilityConfig;
  conversational: ConversationalCapabilityConfig;
};

export const DEFAULT_TEAM_SOLVE_CAPABILITY_CONFIG: TeamSolveCapabilityConfig = {
  maxMembers: 4,
  tokenBudget: 400000,
  timeBudgetSeconds: 1800,
  roles: ["lead", "impl", "reviewer", "prober"],
};

export const CAPABILITY_ALIASES: Record<CapabilityName, CapabilityAlias[]> = {
  review: [
    { kind: "capability", key: "pullRequest" },
    { kind: "capability", key: "review" },
  ],
  conflictAutofix: [{ kind: "capability", key: "conflictAutofix" }],
  conflictResolve: [{ kind: "capability", key: "conflictResolve" }],
  teamSolve: [
    { kind: "intent", value: "team-solve" },
    { kind: "capability", key: "teamSolve" },
  ],
  conversational: [{ kind: "capability", key: "conversational" }],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function personaSpec(spec: unknown): Record<string, unknown> | null {
  return deploymentPersonaSpec(spec) ?? (isRecord(spec) ? spec : null);
}

function personaCapabilities(spec: unknown): Record<string, unknown> | null {
  const persona = personaSpec(spec);
  return isRecord(persona?.capabilities) ? persona.capabilities : null;
}

function capabilityValueEnabled(value: unknown): value is CapabilityValue {
  if (value === true) return true;
  if (!isRecord(value)) return false;
  return value.enabled !== false;
}

const warnedIntentReviewShimKeys = new Set<string>();

function warnIntentReviewCapabilityShim(): void {
  const key = "review:pullRequest";
  if (warnedIntentReviewShimKeys.has(key)) return;
  warnedIntentReviewShimKeys.add(key);
  console.warn(
    "Persona intent:review matched pullRequest via back-compat shim; declare capabilities.pullRequest instead.",
    {
      diag: "persona-intent-review-capability-shim",
      capability: "pullRequest",
      intent: "review",
    },
  );
}

function explicitCapabilityValue(spec: Record<string, unknown>, key: string): unknown {
  const capabilities = personaCapabilities(spec);
  if (!capabilities || !(key in capabilities)) return undefined;
  return capabilities[key];
}

function pullRequestCapabilityEnabled(value: unknown): boolean {
  if (value === true) return true;
  if (!isRecord(value) || value.enabled === false) return false;
  return true;
}

function pullRequestWritebackEnabled(value: unknown): boolean {
  if (value === true) return true;
  if (!isRecord(value) || value.enabled === false) return false;
  return value.writeback === true;
}

function intentReviewShimEnabled(spec: Record<string, unknown>): boolean {
  const persona = personaSpec(spec);
  if (persona?.intent !== "review") return false;
  warnIntentReviewCapabilityShim();
  return true;
}

function positiveIntegerOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function stringArrayOrDefault(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const roles = value.filter((role): role is string => typeof role === "string" && role.length > 0);
  return roles.length > 0 ? roles : [...fallback];
}

function readTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function conversationalCapabilityConfig(value: unknown): ConversationalCapabilityConfig {
  if (value === true) {
    return {
      enabled: true,
      defaultResponder: false,
      channels: [],
    };
  }

  const config = isRecord(value) ? value : {};
  const identity = isRecord(config.identity)
    ? {
      ...(readTrimmedString(config.identity.username)
        ? { username: readTrimmedString(config.identity.username) as string }
        : {}),
      ...(readTrimmedString(config.identity.iconUrl)
        ? { iconUrl: readTrimmedString(config.identity.iconUrl) as string }
        : {}),
    }
    : {};

  return {
    enabled: capabilityValueEnabled(value),
    defaultResponder: config.defaultResponder === true,
    channels: stringArrayOrDefault(config.channels, []),
    ...(Object.keys(identity).length > 0 ? { identity } : {}),
  };
}

function capabilityValueFor(spec: unknown, capability: CapabilityName): unknown {
  const capabilities = personaCapabilities(spec);
  if (!capabilities) return null;

  for (const alias of CAPABILITY_ALIASES[capability]) {
    if (alias.kind === "capability" && alias.key in capabilities) {
      return capabilities[alias.key];
    }
  }

  return null;
}

function teamSolveCapabilityConfig(value: unknown): TeamSolveCapabilityConfig {
  const config = isRecord(value) ? value : {};
  return {
    maxMembers: positiveIntegerOrDefault(
      config.maxMembers,
      DEFAULT_TEAM_SOLVE_CAPABILITY_CONFIG.maxMembers,
    ),
    tokenBudget: positiveIntegerOrDefault(
      config.tokenBudget,
      DEFAULT_TEAM_SOLVE_CAPABILITY_CONFIG.tokenBudget,
    ),
    timeBudgetSeconds: positiveIntegerOrDefault(
      config.timeBudgetSeconds,
      DEFAULT_TEAM_SOLVE_CAPABILITY_CONFIG.timeBudgetSeconds,
    ),
    roles: stringArrayOrDefault(config.roles, DEFAULT_TEAM_SOLVE_CAPABILITY_CONFIG.roles),
  };
}

export function hasPersonaCapability(spec: unknown, capability: CapabilityName): boolean {
  const persona = personaSpec(spec);
  if (!persona) return false;
  if (capability === "review") {
    const pullRequest = explicitCapabilityValue(persona, "pullRequest");
    if (pullRequest !== undefined && pullRequestCapabilityEnabled(pullRequest)) {
      return true;
    }
    const review = explicitCapabilityValue(persona, "review");
    if (review !== undefined) {
      return capabilityValueEnabled(review);
    }
    if (pullRequest !== undefined) {
      return false;
    }
    return intentReviewShimEnabled(persona);
  }

  const capabilities = personaCapabilities(persona);

  for (const alias of CAPABILITY_ALIASES[capability]) {
    if (alias.kind === "intent") {
      if (persona.intent === alias.value) return true;
    } else if (capabilities && capabilityValueEnabled(capabilities[alias.key])) {
      return true;
    }
  }

  return false;
}

export function isPullRequestReviewerPersona(spec: unknown): boolean {
  return hasPersonaCapability(spec, "review");
}

export function personaWantsPullRequestWriteback(spec: unknown): boolean {
  const persona = personaSpec(spec);
  if (!persona) return false;
  const pullRequest = explicitCapabilityValue(persona, "pullRequest");
  if (pullRequest !== undefined) {
    return pullRequestWritebackEnabled(pullRequest);
  }
  return intentReviewShimEnabled(persona);
}

export function isConflictAutofixPersona(spec: unknown): boolean {
  return hasPersonaCapability(spec, "conflictAutofix");
}

export function isConflictResolvePersona(spec: unknown): boolean {
  return hasPersonaCapability(spec, "conflictResolve");
}

export function isTeamSolvePersona(spec: unknown): boolean {
  return hasPersonaCapability(spec, "teamSolve");
}

export function isConversationalPersona(spec: unknown): boolean {
  return hasPersonaCapability(spec, "conversational");
}

export function conversationalConfig(spec: unknown): ConversationalCapabilityConfig {
  return conversationalCapabilityConfig(capabilityValueFor(spec, "conversational"));
}

export function capabilityConfig<C extends CapabilityName>(
  spec: unknown,
  capability: C,
): CapabilityConfigMap[C] {
  const value = capabilityValueFor(spec, capability);
  if (capability === "teamSolve") {
    return teamSolveCapabilityConfig(value) as CapabilityConfigMap[C];
  }
  if (capability === "conversational") {
    return conversationalCapabilityConfig(value) as CapabilityConfigMap[C];
  }
  return (isRecord(value) ? value : null) as CapabilityConfigMap[C];
}
