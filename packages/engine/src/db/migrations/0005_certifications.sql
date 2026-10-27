CREATE TABLE `certifications` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `agent_url` text NOT NULL,
  `level` integer NOT NULL,
  `source` text NOT NULL DEFAULT 'manual',
  `status` text NOT NULL DEFAULT 'pending',
  `passed` integer NOT NULL DEFAULT false,
  `passed_tests` integer NOT NULL DEFAULT 0,
  `total_tests` integer NOT NULL DEFAULT 0,
  `monitor_enabled` integer NOT NULL DEFAULT false,
  `monitor_interval_minutes` integer NOT NULL DEFAULT 60,
  `last_run_at` integer,
  `results` text DEFAULT '[]',
  `created_at` integer NOT NULL DEFAULT (unixepoch()),
  `updated_at` integer NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_certifications_workspace` ON `certifications` (`workspace_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_certifications_agent_url` ON `certifications` (`agent_url`);
--> statement-breakpoint
CREATE INDEX `idx_certifications_monitor_enabled` ON `certifications` (`monitor_enabled`,`updated_at`);
