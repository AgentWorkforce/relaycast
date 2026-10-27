ALTER TABLE `workspaces` ADD `expires_at` integer;
--> statement-breakpoint
CREATE INDEX `idx_workspaces_expires_at` ON `workspaces` (`expires_at`);
