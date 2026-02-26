import { z } from 'zod';

export const ChannelMemberInfoSchema = z.object({
  agent_id: z.string(),
  agent_name: z.string(),
  role: z.enum(['owner', 'member']),
  joined_at: z.string(),
});
export type ChannelMemberInfo = z.infer<typeof ChannelMemberInfoSchema>;

export const ChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  topic: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  created_by: z.string().nullable().optional(),
  created_at: z.string(),
  is_archived: z.boolean().optional(),
  member_count: z.number().optional(),
  members: z.array(ChannelMemberInfoSchema).optional(),
});
export type Channel = z.infer<typeof ChannelSchema>;

export const ChannelMemberSchema = z.object({
  channel_id: z.string(),
  agent_id: z.string(),
  role: z.enum(['owner', 'member']),
  joined_at: z.string(),
  last_read_id: z.string().nullable(),
});
export type ChannelMember = z.infer<typeof ChannelMemberSchema>;

export const CreateChannelRequestSchema = z.object({
  name: z.string(),
  topic: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type CreateChannelRequest = z.infer<typeof CreateChannelRequestSchema>;

export const UpdateChannelRequestSchema = z.object({
  topic: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateChannelRequest = z.infer<typeof UpdateChannelRequestSchema>;

export const InviteRequestSchema = z.object({
  agent_name: z.string(),
});
export type InviteRequest = z.infer<typeof InviteRequestSchema>;

export const JoinChannelResponseSchema = z.object({
  channel: z.string(),
  agent_id: z.string(),
  already_member: z.boolean(),
});
export type JoinChannelResponse = z.infer<typeof JoinChannelResponseSchema>;

export const InviteChannelResponseSchema = z.object({
  channel: z.string(),
  agent: z.string(),
});
export type InviteChannelResponse = z.infer<typeof InviteChannelResponseSchema>;
