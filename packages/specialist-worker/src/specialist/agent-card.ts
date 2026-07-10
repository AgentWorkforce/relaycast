export interface A2AAgentSkill {
  id: string;
  name: string;
  description: string;
}

export interface A2AAgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: {
    streaming: boolean;
    pushNotifications?: boolean;
  };
  skills: A2AAgentSkill[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
}

export interface CardValidationResult {
  valid: boolean;
  recognizedCapabilities: string[];
  unrecognizedSkills: string[];
  errors: string[];
}

const CAPABILITY_ALIASES = new Map<string, string>([
  ["pr_investigation", "pr_investigation"],
  ["github.investigate", "pr_investigation"],
  ["github.enumerate", "github.enumerate"],
  ["github_enumeration", "github.enumerate"],
  ["linear.enumerate", "linear.enumerate"],
  ["linear_enumeration", "linear.enumerate"],
  ["notion.enumerate", "notion.enumerate"],
  ["notion_enumeration", "notion.enumerate"],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Agent card ${field} is required`);
  }
  return value.trim();
}

function readStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Agent card ${field} must be an array`);
  }
  return value.map((entry) => readRequiredString(entry, `${field} entry`));
}

export function normalizeCapability(capability: string): string | null {
  return CAPABILITY_ALIASES.get(capability.trim()) ?? null;
}

export function validateAgentCard(card: A2AAgentCard): CardValidationResult {
  const errors: string[] = [];
  const recognizedCapabilities = new Set<string>();
  const unrecognizedSkills: string[] = [];

  if (!card.name?.trim()) {
    errors.push("Agent card name is required");
  }
  if (!card.description?.trim()) {
    errors.push("Agent card description is required");
  }
  if (!card.version?.trim()) {
    errors.push("Agent card version is required");
  }
  if (!Array.isArray(card.skills) || card.skills.length === 0) {
    errors.push("Agent card must declare at least one skill");
  } else {
    for (const skill of card.skills) {
      if (!skill.id?.trim()) {
        errors.push("Skill missing id");
        continue;
      }
      if (!skill.name?.trim()) {
        errors.push(`Skill "${skill.id}" missing name`);
        continue;
      }
      if (!skill.description?.trim()) {
        errors.push(`Skill "${skill.id}" missing description`);
        continue;
      }

      const normalized = normalizeCapability(skill.id);
      if (normalized) {
        recognizedCapabilities.add(normalized);
      } else {
        unrecognizedSkills.push(skill.id);
      }
    }
  }

  if (recognizedCapabilities.size === 0 && errors.length === 0) {
    errors.push("Agent card has no recognized capabilities");
  }

  return {
    valid: errors.length === 0,
    recognizedCapabilities: [...recognizedCapabilities],
    unrecognizedSkills,
    errors,
  };
}

export function a2aAgentCardFromDict(raw: Record<string, unknown>): A2AAgentCard {
  if (!isRecord(raw.capabilities)) {
    throw new Error("Agent card capabilities are required");
  }

  if (!Array.isArray(raw.skills)) {
    throw new Error("Agent card skills are required");
  }

  return {
    name: readRequiredString(raw.name, "name"),
    description: readRequiredString(raw.description, "description"),
    url: typeof raw.url === "string" ? raw.url.trim() : "",
    version: readRequiredString(raw.version, "version"),
    capabilities: {
      streaming: raw.capabilities.streaming === true,
      ...(raw.capabilities.pushNotifications === undefined
        ? {}
        : { pushNotifications: raw.capabilities.pushNotifications === true }),
    },
    skills: raw.skills.map((entry, index) => {
      if (!isRecord(entry)) {
        throw new Error(`Agent card skill ${index} must be an object`);
      }
      return {
        id: readRequiredString(entry.id, `skills[${index}].id`),
        name: readRequiredString(entry.name, `skills[${index}].name`),
        description: readRequiredString(entry.description, `skills[${index}].description`),
      };
    }),
    defaultInputModes: readStringArray(raw.defaultInputModes ?? ["text"], "defaultInputModes"),
    defaultOutputModes: readStringArray(raw.defaultOutputModes ?? ["text"], "defaultOutputModes"),
  };
}

export async function fetchSpecialistCard(url: string): Promise<A2AAgentCard> {
  const baseUrl = url.replace(/\/+$/, "");
  const cardUrl = `${baseUrl}/.well-known/agent.json`;
  // Use `globalThis.fetch` rather than a bare `fetch` identifier: Cloudflare
  // Workers with `nodejs_compat` can hoist bare `fetch` off `globalThis` and
  // throw `TypeError: Illegal invocation`. See sage `.claude/rules/workers-fetch.md`.
  const response = await globalThis.fetch(cardUrl, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    response.body?.cancel().catch(() => {});
    throw new Error(`Failed to fetch agent card from ${cardUrl}: ${response.status}`);
  }

  const raw = (await response.json()) as Record<string, unknown>;
  return a2aAgentCardFromDict(raw);
}
