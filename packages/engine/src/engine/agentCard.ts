import {
  AGENT_CARD_PROTOCOL_VERSION,
  AgentCardMetadataSchema,
  type AgentCard,
  type AgentCardMetadata,
  type AgentCardSkill,
} from '@relaycast/types';

/** A skill declared on an agent record (`metadata.skills`), read defensively. */
export interface DeclaredAgentSkill {
  id: string;
  name: string;
  description?: string;
  tags: string[];
  examples?: string[];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Kebab-case id derived from a skill name, for skills declared without an id. */
export function skillIdFromName(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
}

/**
 * Skills stored at `metadata.skills`. Rows written before validation existed
 * may hold anything, so malformed entries are skipped rather than trusted.
 * Ids are unique per agent: a derived id that collides gets a numeric suffix.
 */
export function readDeclaredSkills(metadata: Record<string, unknown> | null | undefined): DeclaredAgentSkill[] {
  const raw = metadata?.skills;
  if (!Array.isArray(raw)) return [];
  const used = new Set<string>();
  const skills: DeclaredAgentSkill[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const skill = value as Record<string, unknown>;
    const name = nonEmptyString(skill.name)?.trim();
    if (!name) continue;
    const base = nonEmptyString(skill.id)?.trim() ?? skillIdFromName(name);
    let id = base;
    for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
    used.add(id);
    const examples = stringArray(skill.examples);
    skills.push({
      id,
      name,
      ...(typeof skill.description === 'string' ? { description: skill.description } : {}),
      tags: stringArray(skill.tags),
      ...(examples.length > 0 ? { examples } : {}),
    });
  }
  return skills;
}

/** The stored card at `metadata.card`, or null when absent or malformed. */
export function readCardMetadata(metadata: Record<string, unknown> | null | undefined): AgentCardMetadata | null {
  const parsed = AgentCardMetadataSchema.safeParse(metadata?.card);
  return parsed.success ? parsed.data : null;
}

export interface AgentCardSource {
  name: string;
  type: string;
  persona: string | null;
  address: string | null;
  status: string;
  metadata: Record<string, unknown> | null;
}

/**
 * Build the A2A agent card (camelCase, A2A spec shape) for one local agent.
 *
 * - `description`: `metadata.card.description`, else the persona, else
 *   `metadata.description`, else a generic line.
 * - `x-agent-relay.kind`: `metadata.kind` when set, else the agent type.
 * - `x-agent-relay.owner`: `metadata.owner_name`, else `metadata.owner`
 *   (omitted when neither is a string).
 * - `x-agent-relay.where`: `metadata.where`, else the machine part of the address.
 * - `x-agent-relay.hasCard`: the agent declared a card or at least one skill.
 */
export function buildAgentCard(agent: AgentCardSource, workspaceName: string, baseUrl: string): AgentCard {
  const metadata = agent.metadata ?? {};
  const card = readCardMetadata(metadata);
  const declared = readDeclaredSkills(metadata);
  const description = card?.description
    ?? nonEmptyString(agent.persona)
    ?? nonEmptyString(metadata.description)
    ?? `${agent.name} on Agent Relay`;
  const skills: AgentCardSkill[] = declared.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description ?? '',
    tags: skill.tags,
    ...(skill.examples ? { examples: skill.examples } : {}),
  }));
  const address = agent.address ?? agent.name;
  const machine = agent.address?.includes('@') ? agent.address.slice(agent.address.indexOf('@') + 1) : undefined;
  const owner = nonEmptyString(metadata.owner_name) ?? nonEmptyString(metadata.owner);
  const where = nonEmptyString(metadata.where) ?? machine;

  return {
    protocolVersion: AGENT_CARD_PROTOCOL_VERSION,
    name: agent.name,
    description,
    url: `${baseUrl}/a2a/rpc`,
    preferredTransport: 'JSONRPC',
    version: card?.version ?? '1',
    provider: { organization: workspaceName, url: 'https://agentrelay.com' },
    ...(card?.documentation_url ? { documentationUrl: card.documentation_url } : {}),
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills,
    'x-agent-relay': {
      address,
      kind: nonEmptyString(metadata.kind) ?? agent.type,
      ...(owner ? { owner } : {}),
      ...(where ? { where } : {}),
      status: agent.status === 'offline' ? 'offline' : 'live',
      tags: card?.tags ?? [],
      ...(card ? { cardUpdatedAt: card.updated_at } : {}),
      hasCard: card !== null || skills.length > 0,
    },
  };
}
