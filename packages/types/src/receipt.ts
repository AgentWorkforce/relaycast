import { z } from 'zod';

export const ReadReceiptSchema = z.object({
  message_id: z.string(),
  agent_id: z.string(),
  read_at: z.string(),
});
export type ReadReceipt = z.infer<typeof ReadReceiptSchema>;

export const ReaderInfoSchema = z.object({
  agent_name: z.string(),
  agent_id: z.string(),
  read_at: z.string(),
});
export type ReaderInfo = z.infer<typeof ReaderInfoSchema>;

export const ChannelReadStatusSchema = z.object({
  agent_name: z.string(),
  last_read_id: z.string().nullable(),
  last_read_at: z.string().nullable(),
});
export type ChannelReadStatus = z.infer<typeof ChannelReadStatusSchema>;
