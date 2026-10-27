import { z } from 'zod';

export const ApiSuccessSchema = <T extends z.ZodType>(dataSchema: T) =>
  z.object({
    ok: z.literal(true),
    data: dataSchema,
    cursor: z.object({
      next: z.string().nullable(),
      has_more: z.boolean(),
    }).optional(),
  });

export const ApiErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export const ApiResponseSchema = <T extends z.ZodType>(dataSchema: T) =>
  z.discriminatedUnion('ok', [ApiSuccessSchema(dataSchema), ApiErrorSchema]) as unknown as z.ZodType<ApiResponse<z.output<T>>>;

export const InboxResponseSchema = z.object({
  unread_channels: z.array(z.object({ channel_name: z.string(), unread_count: z.number() })),
  mentions: z.array(z.object({ id: z.string(), channel_name: z.string(), agent_name: z.string(), text: z.string(), created_at: z.string() })),
  unread_dms: z.array(z.object({
    conversation_id: z.string(),
    from: z.string(),
    unread_count: z.number(),
    last_message: z.object({ id: z.string(), text: z.string(), created_at: z.string() }).nullable(),
  })),
  recent_reactions: z.array(z.object({
    message_id: z.string(),
    channel_name: z.string(),
    emoji: z.string(),
    agent_name: z.string(),
    created_at: z.string(),
  })),
});

export interface ApiSuccess<T> {
  ok: true;
  data: T;
  cursor?: {
    next: string | null;
    has_more: boolean;
  };
}

export interface ApiError {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;
export type InboxResponse = z.infer<typeof InboxResponseSchema>;
