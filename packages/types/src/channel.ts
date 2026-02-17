import { z } from 'zod';

export const ChannelSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  name: z.string(),
  channel_type: z.number(),
  topic: z.string().nullable(),
  created_by: z.string().nullable(),
  created_at: z.string(),
  is_archived: z.boolean(),
  member_count: z.number().optional(),
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
  topic: z.string().optional(),
});
export type CreateChannelRequest = z.infer<typeof CreateChannelRequestSchema>;

export const UpdateChannelRequestSchema = z.object({
  topic: z.string().optional(),
});
export type UpdateChannelRequest = z.infer<typeof UpdateChannelRequestSchema>;

export const ChannelMemberInfoSchema = z.object({
  agent_id: z.string(),
  agent_name: z.string(),
  role: z.enum(['owner', 'member']),
  joined_at: z.string(),
});
export type ChannelMemberInfo = z.infer<typeof ChannelMemberInfoSchema>;

export const InviteRequestSchema = z.object({
  agent: z.string(),
});
export type InviteRequest = z.infer<typeof InviteRequestSchema>;
