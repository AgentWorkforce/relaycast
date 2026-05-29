CREATE TABLE `message_logs` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `message_id` text NOT NULL,
  `channel_id` text NOT NULL,
  `agent_id` text NOT NULL,
  `conversation_id` text,
  `delivery_kind` text NOT NULL,
  `body` text NOT NULL,
  `content_type` text,
  `metadata` text DEFAULT '{}',
  `attachment_count` integer DEFAULT 0 NOT NULL,
  `mention_count` integer DEFAULT 0 NOT NULL,
  `latency_ms` integer DEFAULT 0 NOT NULL,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_logs_message_unique` ON `message_logs` (`message_id`);
--> statement-breakpoint
CREATE INDEX `idx_message_logs_workspace_time` ON `message_logs` (`workspace_id`, `id`);
--> statement-breakpoint
CREATE INDEX `idx_message_logs_agent_time` ON `message_logs` (`agent_id`, `id`);
--> statement-breakpoint
CREATE INDEX `idx_message_logs_channel_time` ON `message_logs` (`channel_id`, `id`);
--> statement-breakpoint
CREATE INDEX `idx_message_logs_conversation_time` ON `message_logs` (`conversation_id`, `id`);
