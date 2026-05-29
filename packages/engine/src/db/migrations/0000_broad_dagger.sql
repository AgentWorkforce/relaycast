CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'agent' NOT NULL,
	`token_hash` text NOT NULL,
	`status` text DEFAULT 'online' NOT NULL,
	`persona` text,
	`metadata` text DEFAULT '{}',
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_seen` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_token_hash_unique` ON `agents` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `agents_workspace_name_unique` ON `agents` (`workspace_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_agents_workspace` ON `agents` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `idx_agents_token` ON `agents` (`token_hash`);--> statement-breakpoint
CREATE TABLE `channel_members` (
	`channel_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`joined_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_read_id` text,
	PRIMARY KEY(`channel_id`, `agent_id`),
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_channel_members_agent` ON `channel_members` (`agent_id`);--> statement-breakpoint
CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`channel_type` integer DEFAULT 0 NOT NULL,
	`topic` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`is_archived` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channels_workspace_name_unique` ON `channels` (`workspace_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_channels_workspace` ON `channels` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `commands` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`command` text NOT NULL,
	`description` text NOT NULL,
	`handler_agent_id` text NOT NULL,
	`parameters` text DEFAULT '[]',
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`handler_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `commands_workspace_command_unique` ON `commands` (`workspace_id`,`command`);--> statement-breakpoint
CREATE INDEX `idx_commands_workspace` ON `commands` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `idx_commands_handler` ON `commands` (`handler_agent_id`);--> statement-breakpoint
CREATE TABLE `dm_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`dm_type` text DEFAULT '1:1' NOT NULL,
	`name` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_dm_conversations_workspace` ON `dm_conversations` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `dm_participants` (
	`conversation_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`joined_at` integer DEFAULT (unixepoch()) NOT NULL,
	`left_at` integer,
	PRIMARY KEY(`conversation_id`, `agent_id`),
	FOREIGN KEY (`conversation_id`) REFERENCES `dm_conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_dm_participants_agent` ON `dm_participants` (`agent_id`);--> statement-breakpoint
CREATE TABLE `event_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`events` text NOT NULL,
	`filter` text,
	`url` text NOT NULL,
	`secret` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_event_subscriptions_workspace` ON `event_subscriptions` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`uploaded_by` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`storage_key` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_files_workspace` ON `files` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_files_uploader` ON `files` (`uploaded_by`);--> statement-breakpoint
CREATE TABLE `message_attachments` (
	`message_id` text NOT NULL,
	`file_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`message_id`, `file_id`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_message_attachments_file` ON `message_attachments` (`file_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`thread_id` text,
	`body` text NOT NULL,
	`blocks` text,
	`has_attachments` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`thread_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_messages_channel_time` ON `messages` (`channel_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_messages_thread` ON `messages` (`thread_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_messages_workspace` ON `messages` (`workspace_id`,`id`);--> statement-breakpoint
CREATE TABLE `pending_events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`event_type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`process_after` integer DEFAULT (unixepoch()) NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_pending_events_status` ON `pending_events` (`status`,`process_after`);--> statement-breakpoint
CREATE INDEX `idx_pending_events_workspace` ON `pending_events` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `reactions` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`emoji` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reactions_message_agent_emoji_unique` ON `reactions` (`message_id`,`agent_id`,`emoji`);--> statement-breakpoint
CREATE INDEX `idx_reactions_message` ON `reactions` (`message_id`);--> statement-breakpoint
CREATE TABLE `read_receipts` (
	`message_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`read_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`message_id`, `agent_id`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_read_receipts_message` ON `read_receipts` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_read_receipts_agent` ON `read_receipts` (`agent_id`,`read_at`);--> statement-breakpoint
CREATE TABLE `usage_records` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	`messages_sent` integer DEFAULT 0 NOT NULL,
	`api_calls` integer DEFAULT 0 NOT NULL,
	`files_uploaded` integer DEFAULT 0 NOT NULL,
	`file_bytes` integer DEFAULT 0 NOT NULL,
	`ws_minutes` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_usage_workspace_period` ON `usage_records` (`workspace_id`,`period_start`);--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`channel_id` text NOT NULL,
	`created_by` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhooks_workspace_name_unique` ON `webhooks` (`workspace_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_webhooks_workspace` ON `webhooks` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`api_key_hash` text NOT NULL,
	`system_prompt` text,
	`plan` text DEFAULT 'free' NOT NULL,
	`stripe_customer_id` text,
	`stripe_subscription_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`metadata` text DEFAULT '{}'
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_name_unique` ON `workspaces` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_api_key_hash_unique` ON `workspaces` (`api_key_hash`);