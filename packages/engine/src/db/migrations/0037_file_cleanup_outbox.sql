-- Record the exact expiry of each issued upload capability. Existing pending
-- uploads are conservatively protected for one hour when their file row is
-- removed, matching the documented FileStorage URL lifetime.
ALTER TABLE `files` ADD `upload_expires_at` integer;
--> statement-breakpoint

-- This outbox intentionally has no workspace FK: cleanup must remain durable
-- after the workspace and its file metadata have committed their deletion.
CREATE TABLE `file_cleanup_queue` (
  `storage_key` text PRIMARY KEY NOT NULL,
  `delete_after` integer NOT NULL,
  `process_after` integer DEFAULT (unixepoch()) NOT NULL,
  `attempts` integer DEFAULT 0 NOT NULL,
  `last_error` text,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_file_cleanup_due`
  ON `file_cleanup_queue` (`process_after`, `storage_key`);
--> statement-breakpoint

-- Queue the object in the same transaction that removes its metadata. This
-- trigger also runs for workspace FK cascades, closing the upload/delete race:
-- an upload row commits before the workspace delete and is queued, or it loses
-- the race and its workspace FK insert fails.
CREATE TRIGGER `files_enqueue_object_cleanup`
AFTER DELETE ON `files`
BEGIN
  INSERT INTO `file_cleanup_queue` (`storage_key`, `delete_after`)
  VALUES (
    OLD.`storage_key`,
    MAX(unixepoch(), COALESCE(OLD.`upload_expires_at`, unixepoch() + 3600))
  )
  ON CONFLICT (`storage_key`) DO UPDATE SET
    `delete_after` = MAX(`file_cleanup_queue`.`delete_after`, excluded.`delete_after`);
END;
