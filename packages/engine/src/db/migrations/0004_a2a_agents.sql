CREATE TABLE `a2a_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`relay_agent_id` text NOT NULL,
	`agent_card` text DEFAULT '{}' NOT NULL,
	`external_url` text NOT NULL,
	`auth_scheme` text,
	`auth_credential` text,
	`status` text DEFAULT 'active' NOT NULL,
	`messages_sent` integer DEFAULT 0 NOT NULL,
	`messages_recv` integer DEFAULT 0 NOT NULL,
	`last_health` integer,
	`health_failures` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`relay_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_a2a_agents_workspace` ON `a2a_agents` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_a2a_agents_relay_agent` ON `a2a_agents` (`relay_agent_id`);
