import { z } from 'zod';

export const ReactionSchema = z.object({
  id: z.string(),
  message_id: z.string(),
  agent_id: z.string(),
  emoji: z.string(),
  created_at: z.string(),
});
export type Reaction = z.infer<typeof ReactionSchema>;

export const AddReactionRequestSchema = z.object({
  emoji: z.string(),
});
export type AddReactionRequest = z.infer<typeof AddReactionRequestSchema>;

export const AddedReactionSchema = z.object({
  id: z.string(),
  message_id: z.string(),
  agent_name: z.string(),
  emoji: z.string(),
  created_at: z.string(),
});
export type AddedReaction = z.infer<typeof AddedReactionSchema>;

export const ReactionGroupSchema = z.object({
  emoji: z.string(),
  count: z.number(),
  agents: z.array(z.string()),
});
export type ReactionGroup = z.infer<typeof ReactionGroupSchema>;
