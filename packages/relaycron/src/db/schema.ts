import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    key_hash: text("key_hash").notNull(),
    key_prefix: text("key_prefix").notNull(),
    created_at: text("created_at").notNull(),
    last_used_at: text("last_used_at"),
  },
  (t) => ({
    // UNIQUE index — the authorization middleware looks up keys by
    // key_hash with .limit(1). Without uniqueness, a hash collision
    // or duplicate seed row would silently auth as whichever row D1
    // returns first (non-deterministic trust identity). Named to
    // match 0000_init.sql so drizzle-kit doesn't see it as a rename.
    idxApiKeysHash: uniqueIndex("idx_api_keys_hash").on(t.key_hash),
  }),
);

export const schedules = sqliteTable(
  "schedules",
  {
    id: text("id").primaryKey(),
    api_key_id: text("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    schedule_type: text("schedule_type", { enum: ["once", "cron"] }).notNull(),
    cron_expression: text("cron_expression"),
    scheduled_at: text("scheduled_at"),
    timezone: text("timezone").notNull().default("UTC"),
    payload: text("payload").notNull(), // JSON
    transport_type: text("transport_type", {
      enum: ["webhook", "websocket"],
    }).notNull(),
    transport_config: text("transport_config").notNull(), // JSON
    status: text("status", {
      enum: ["active", "paused", "completed", "expired"],
    })
      .notNull()
      .default("active"),
    next_run_at: text("next_run_at"),
    last_run_at: text("last_run_at"),
    run_count: integer("run_count").notNull().default(0),
    failure_count: integer("failure_count").notNull().default(0),
    metadata: text("metadata"), // JSON
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (t) => ({
    idxSchedulesApiKey: index("idx_schedules_api_key").on(t.api_key_id),
    idxSchedulesStatus: index("idx_schedules_status").on(t.status),
    idxSchedulesNextRun: index("idx_schedules_next_run").on(t.next_run_at),
  }),
);

export const executions = sqliteTable(
  "executions",
  {
    id: text("id").primaryKey(),
    schedule_id: text("schedule_id")
      .notNull()
      .references(() => schedules.id, { onDelete: "cascade" }),
    started_at: text("started_at").notNull(),
    completed_at: text("completed_at"),
    status: text("status", {
      enum: ["success", "failure", "timeout"],
    }).notNull(),
    transport_type: text("transport_type", {
      enum: ["webhook", "websocket"],
    }).notNull(),
    http_status: integer("http_status"),
    response_body: text("response_body"),
    error: text("error"),
    duration_ms: integer("duration_ms"),
  },
  (t) => ({
    idxExecutionsSchedule: index("idx_executions_schedule").on(t.schedule_id),
    idxExecutionsStarted: index("idx_executions_started").on(t.started_at),
  }),
);
