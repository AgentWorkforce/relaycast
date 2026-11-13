import { z } from 'zod';

/** Lowercase SHA-256 verifier accepted for server-owned recovery proofs. */
export const AGENT_RECOVERY_PROOF_HASH_PATTERN = /^[a-f0-9]{64}$/;
export const AGENT_TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/;

export const AgentTypeSchema = z.enum(['agent', 'human', 'system']);
export type AgentType = z.infer<typeof AgentTypeSchema>;

export const AgentStatusSchema = z.enum(['online', 'offline', 'away']);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const AgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  /**
   * `agent@machine` for `address` on POST /v1/dm; `machine` is `direct` for a
   * self-connected agent. Null when the agent is not hosted anywhere.
   */
  address: z.string().nullable().optional(),
  type: AgentTypeSchema,
  status: AgentStatusSchema,
  persona: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  /**
   * The node whose authenticated connection registered this agent, set once by
   * the server and not patchable (unlike `metadata.fleet`). Agent detail only.
   */
  origin_node_id: z.string().nullable().optional(),
  last_seen: z.string(),
  created_at: z.string().optional(),
  channels: z.array(z.object({
    id: z.string(),
    name: z.string(),
    role: z.enum(['owner', 'member']),
    joined_at: z.string(),
  })).optional(),
});
export type Agent = z.infer<typeof AgentSchema>;

/** Bounds for skills stored on an agent (`metadata.skills`) and its A2A card. */
export const AGENT_SKILLS_MAX = 20;
export const AGENT_SKILL_NAME_MAX = 80;
export const AGENT_SKILL_DESCRIPTION_MAX = 500;
export const AGENT_SKILL_EXAMPLES_MAX = 5;
export const AGENT_SKILL_EXAMPLE_MAX = 200;
export const AGENT_CARD_DESCRIPTION_MAX = 1000;
export const AGENT_CARD_TAGS_MAX = 10;
/** A2A protocol version of the cards `GET /v1/agents/:name/card` returns. */
export const AGENT_CARD_PROTOCOL_VERSION = '0.3.0';

export const AgentSkillInputSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1).max(AGENT_SKILL_NAME_MAX),
  description: z.string().max(AGENT_SKILL_DESCRIPTION_MAX).optional(),
  tags: z.array(z.string().min(1)).optional(),
  /** Short example requests a peer could send for this skill. */
  examples: z.array(z.string().min(1).max(AGENT_SKILL_EXAMPLE_MAX)).max(AGENT_SKILL_EXAMPLES_MAX).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type AgentSkillInput = z.infer<typeof AgentSkillInputSchema>;

/** An agent's declared skills: at most 20, with unique explicit ids. */
export const AgentSkillsInputSchema = z.array(AgentSkillInputSchema)
  .max(AGENT_SKILLS_MAX)
  .superRefine((skills, ctx) => {
    const seen = new Set<string>();
    skills.forEach((skill, index) => {
      if (skill.id === undefined) return;
      if (seen.has(skill.id)) {
        ctx.addIssue({ code: 'custom', path: [index, 'id'], message: `duplicate skill id "${skill.id}"` });
      }
      seen.add(skill.id);
    });
  });

/**
 * The agent card fields stored at `metadata.card` (snake_case, like the rest of
 * the wire). Skills live beside it at `metadata.skills`.
 */
export const AgentCardMetadataSchema = z.object({
  description: z.string().min(1).max(AGENT_CARD_DESCRIPTION_MAX),
  documentation_url: z.string().url().refine((url) => url.startsWith('https://'), 'documentation_url must be https').optional(),
  tags: z.array(z.string().min(1)).max(AGENT_CARD_TAGS_MAX).optional(),
  updated_at: z.string().datetime({ offset: true }),
  version: z.string().min(1),
});
export type AgentCardMetadata = z.infer<typeof AgentCardMetadataSchema>;

/**
 * Agent metadata as accepted on register and update: free-form, except that a
 * `card` key, when present, must be a valid {@link AgentCardMetadataSchema}.
 */
export const AgentMetadataInputSchema = z.record(z.string(), z.unknown()).superRefine((metadata, ctx) => {
  if (metadata.card === undefined) return;
  const parsed = AgentCardMetadataSchema.safeParse(metadata.card);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({ code: 'custom', path: ['card', ...issue.path], message: issue.message });
    }
  }
});

/** One skill on an A2A agent card (camelCase, per the A2A spec). */
export const AgentCardSkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  examples: z.array(z.string()).optional(),
});
export type AgentCardSkill = z.infer<typeof AgentCardSkillSchema>;

/**
 * The A2A agent card `GET /v1/agents/:name/card` returns. Its keys are the A2A
 * spec's camelCase, not the snake_case of the rest of the wire, so any A2A
 * client can consume it unchanged. `x-agent-relay` carries Agent Relay fields.
 */
export const AgentCardSchema = z.object({
  protocolVersion: z.string(),
  name: z.string(),
  description: z.string(),
  url: z.string(),
  preferredTransport: z.literal('JSONRPC'),
  version: z.string(),
  provider: z.object({ organization: z.string(), url: z.string() }),
  documentationUrl: z.string().optional(),
  capabilities: z.object({ streaming: z.boolean(), pushNotifications: z.boolean() }),
  defaultInputModes: z.array(z.string()),
  defaultOutputModes: z.array(z.string()),
  skills: z.array(AgentCardSkillSchema),
  'x-agent-relay': z.object({
    address: z.string(),
    kind: z.string(),
    owner: z.string().optional(),
    where: z.string().optional(),
    status: z.enum(['live', 'offline']),
    tags: z.array(z.string()),
    cardUpdatedAt: z.string().optional(),
    hasCard: z.boolean(),
  }),
});
export type AgentCard = z.infer<typeof AgentCardSchema>;

export const CreateAgentRequestSchema = z.object({
  auto_join_general: z.boolean().optional(),
  name: z.string(),
  type: AgentTypeSchema.optional(),
  persona: z.string().optional(),
  metadata: AgentMetadataInputSchema.optional(),
  skills: AgentSkillsInputSchema.optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  recovery_proof_hash: z.string().regex(AGENT_RECOVERY_PROOF_HASH_PATTERN).optional(),
  work_unit_id: z.string().min(1).optional(),
});
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;

export const CreateAgentResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  token: z.string(),
  status: AgentStatusSchema,
  created_at: z.string(),
});
export type CreateAgentResponse = z.infer<typeof CreateAgentResponseSchema>;

/**
 * `metadata` is merged into the stored metadata one top-level key at a time
 * (keys not sent are kept); `skills` replaces `metadata.skills`.
 */
export const UpdateAgentRequestSchema = z.object({
  status: AgentStatusSchema.optional(),
  persona: z.string().nullable().optional(),
  metadata: AgentMetadataInputSchema.optional(),
  skills: AgentSkillsInputSchema.optional(),
  capabilities: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequestSchema>;

export const AgentListQuerySchema = z.object({
  status: z.enum(['online', 'offline', 'away', 'active', 'idle', 'blocked', 'waiting', 'all']).optional(),
  include_stale: z.boolean().optional(),
  include_metadata: z.boolean().optional(),
});
export type AgentListQuery = z.infer<typeof AgentListQuerySchema>;

export const AgentPresenceInfoSchema = z.object({
  agent_id: z.string(),
  agent_name: z.string(),
  status: z.enum(['online', 'offline']),
});
export type AgentPresenceInfo = z.infer<typeof AgentPresenceInfoSchema>;

// === Spawn/Release (Agent Lifecycle) ===

export const CliTypeSchema = z.enum(['claude', 'codex', 'gemini', 'aider', 'goose', 'opencode', 'grok', 'muse', 'devin']);
export type CliType = z.infer<typeof CliTypeSchema>;

export const SpawnAgentRequestSchema = z.object({
  name: z.string(),
  cli: CliTypeSchema,
  task: z.string(),
  channel: z.string().nullable().optional(),
  persona: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type SpawnAgentRequest = z.infer<typeof SpawnAgentRequestSchema>;

const LifecycleActionInvocationResponseSchema = z.object({
  invocation_id: z.string(),
  action_name: z.string(),
  handler_agent_id: z.string().nullable(),
  handler_node_id: z.string().nullable(),
  dispatched_node_id: z.string().nullable().optional(),
  input: z.record(z.string(), z.unknown()),
  status: z.string(),
  created_at: z.string(),
});

export const SpawnAgentResponseSchema = LifecycleActionInvocationResponseSchema;
export type SpawnAgentResponse = z.infer<typeof SpawnAgentResponseSchema>;

export const ReleaseAgentRequestSchema = z.object({
  name: z.string(),
  reason: z.string().nullable().optional(),
  delete_agent: z.boolean().optional(),
  expected_token_hash: z.string().regex(AGENT_TOKEN_HASH_PATTERN).optional(),
});
export type ReleaseAgentRequest = z.infer<typeof ReleaseAgentRequestSchema>;

/**
 * Server-authorized release reconciliation. Unlike the legacy name-addressed
 * request this pins the mutation to the immutable agent row id.
 */
export const ExactReleaseAgentRequestSchema = ReleaseAgentRequestSchema.extend({
  expected_agent_id: z.string().min(1),
});
export type ExactReleaseAgentRequest = z.infer<typeof ExactReleaseAgentRequestSchema>;

export const ReleaseAgentResponseSchema = LifecycleActionInvocationResponseSchema;
export type ReleaseAgentResponse = z.infer<typeof ReleaseAgentResponseSchema>;
