CREATE TABLE `api_keys` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `key_hash` text NOT NULL,
  `key_prefix` text NOT NULL,
  `created_at` text NOT NULL,
  `last_used_at` text
);

CREATE TABLE `schedules` (
  `id` text PRIMARY KEY NOT NULL,
  `api_key_id` text NOT NULL REFERENCES `api_keys`(`id`) ON DELETE CASCADE,
  `name` text NOT NULL,
  `description` text,
  `schedule_type` text NOT NULL,
  `cron_expression` text,
  `scheduled_at` text,
  `timezone` text NOT NULL DEFAULT 'UTC',
  `payload` text NOT NULL,
  `transport_type` text NOT NULL,
  `transport_config` text NOT NULL,
  `status` text NOT NULL DEFAULT 'active',
  `next_run_at` text,
  `last_run_at` text,
  `run_count` integer NOT NULL DEFAULT 0,
  `failure_count` integer NOT NULL DEFAULT 0,
  `metadata` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);

CREATE TABLE `executions` (
  `id` text PRIMARY KEY NOT NULL,
  `schedule_id` text NOT NULL REFERENCES `schedules`(`id`) ON DELETE CASCADE,
  `started_at` text NOT NULL,
  `completed_at` text,
  `status` text NOT NULL,
  `transport_type` text NOT NULL,
  `http_status` integer,
  `response_body` text,
  `error` text,
  `duration_ms` integer
);

CREATE INDEX `idx_schedules_api_key` ON `schedules`(`api_key_id`);
CREATE INDEX `idx_schedules_status` ON `schedules`(`status`);
CREATE INDEX `idx_schedules_next_run` ON `schedules`(`next_run_at`);
CREATE INDEX `idx_executions_schedule` ON `executions`(`schedule_id`);
CREATE INDEX `idx_executions_started` ON `executions`(`started_at`);
CREATE UNIQUE INDEX `idx_api_keys_hash` ON `api_keys`(`key_hash`);
