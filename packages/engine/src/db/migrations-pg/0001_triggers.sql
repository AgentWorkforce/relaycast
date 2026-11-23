-- PL/pgSQL ports of the 28 triggers a fully migrated SQLite engine database
-- carries (src/db/migrations). One function per trigger, named after it.
--
-- Porting rules (identical observable semantics):
-- * Every SQLite trigger is FOR EACH ROW; so is every trigger here.
-- * SQLite AFTER triggers that "UPDATE <same table> ... WHERE id = NEW.id" stay
--   AFTER row triggers doing the same self-UPDATE. The column each one writes
--   is outside every UPDATE OF list on that table, so - exactly like SQLite
--   with recursive_triggers off - the self-UPDATE never re-fires a trigger,
--   and RETURNING still reports the pre-trigger row in both databases.
-- * WHEN clauses without subqueries stay on CREATE TRIGGER; `a IS b` becomes
--   `a IS NOT DISTINCT FROM b`. WHEN clauses with subqueries (Postgres does
--   not allow them) move into the function body.
-- * RAISE(ABORT, msg) becomes RAISE EXCEPTION with the same message and
--   SQLSTATE 23000 (integrity_constraint_violation); the statement aborts.
-- * Two-argument MAX(a, b) becomes GREATEST(a, b); every operand here is
--   NOT NULL, so SQLite's NULL-propagating MAX and GREATEST agree.
-- * unixepoch() becomes floor(extract(epoch from statement_timestamp())),
--   which, like unixepoch(), is fixed for the duration of the statement.
-- * FTS5 external-content tables become ordinary mirror tables keyed by the
--   content table's rowid, with a generated tsvector ('simple' config) and a
--   GIN index. The triggers keep them in step exactly as the FTS5 triggers do;
--   the messages_mention_fts docsize-existence guards become
--   ON CONFLICT DO NOTHING / delete-by-rowid. The tsvector shape is
--   provisional: the Postgres search implementation owns it.
-- * Functions pin search_path and qualify every relation.
--
-- The NOT NULL "sentinel" failures the engine relies on (messages.agent_id,
-- deliveries.workspace_id, nodes.active_agents, ...) are not triggers:
-- Postgres raises SQLSTATE 23502 with the same table and column natively.

-- ============================================
-- messages
-- ============================================
CREATE FUNCTION "public"."a2a_inbound_source_prune"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE "public"."a2a_inbound" SET "response" = NULL WHERE "message_id" = OLD."id";
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "a2a_inbound_source_prune"
BEFORE DELETE ON "public"."messages"
FOR EACH ROW EXECUTE FUNCTION "public"."a2a_inbound_source_prune"();
--> statement-breakpoint

-- ============================================
-- action_invocations
-- ============================================
CREATE FUNCTION "public"."action_invocations_stamp_node_liveness_revision_insert"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE "public"."action_invocations"
  SET "node_liveness_revision" = COALESCE((
    SELECT n."liveness_revision" + 1
    FROM "public"."nodes" n
    WHERE n."workspace_id" = NEW."workspace_id" AND n."id" = NEW."dispatched_node_id"
  ), 1)
  WHERE "id" = NEW."id";
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "action_invocations_stamp_node_liveness_revision_insert"
AFTER INSERT ON "public"."action_invocations"
FOR EACH ROW
WHEN (NEW."dispatched_node_id" IS NOT NULL)
EXECUTE FUNCTION "public"."action_invocations_stamp_node_liveness_revision_insert"();
--> statement-breakpoint
CREATE FUNCTION "public"."action_invocations_stamp_node_liveness_revision_update"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE "public"."action_invocations"
  SET "node_liveness_revision" = COALESCE((
    SELECT n."liveness_revision" + 1
    FROM "public"."nodes" n
    WHERE n."workspace_id" = NEW."workspace_id" AND n."id" = NEW."dispatched_node_id"
  ), OLD."node_liveness_revision" + 1)
  WHERE "id" = NEW."id";
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "action_invocations_stamp_node_liveness_revision_update"
AFTER UPDATE OF "status", "dispatched_node_id", "dispatched_at", "dispatch_attempts" ON "public"."action_invocations"
FOR EACH ROW
WHEN (NEW."dispatched_node_id" IS NOT NULL AND NEW."node_liveness_revision" = OLD."node_liveness_revision")
EXECUTE FUNCTION "public"."action_invocations_stamp_node_liveness_revision_update"();
--> statement-breakpoint

-- ============================================
-- agent_node_bindings
-- ============================================
CREATE FUNCTION "public"."agent_node_bindings_workspace_agent_insert"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "public"."agents" a
    WHERE a."workspace_id" = NEW."workspace_id" AND a."id" = NEW."agent_id"
  ) THEN
    RAISE EXCEPTION 'agent_node_bindings workspace/agent mismatch' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "agent_node_bindings_workspace_agent_insert"
BEFORE INSERT ON "public"."agent_node_bindings"
FOR EACH ROW EXECUTE FUNCTION "public"."agent_node_bindings_workspace_agent_insert"();
--> statement-breakpoint
CREATE FUNCTION "public"."agent_node_bindings_workspace_agent_update"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "public"."agents" a
    WHERE a."workspace_id" = NEW."workspace_id" AND a."id" = NEW."agent_id"
  ) THEN
    RAISE EXCEPTION 'agent_node_bindings workspace/agent mismatch' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "agent_node_bindings_workspace_agent_update"
BEFORE UPDATE OF "workspace_id", "agent_id" ON "public"."agent_node_bindings"
FOR EACH ROW EXECUTE FUNCTION "public"."agent_node_bindings_workspace_agent_update"();
--> statement-breakpoint
CREATE FUNCTION "public"."agent_node_bindings_workspace_node_insert"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "public"."nodes" n
    WHERE n."workspace_id" = NEW."workspace_id" AND n."id" = NEW."node_id"
  ) THEN
    RAISE EXCEPTION 'agent_node_bindings workspace/node mismatch' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "agent_node_bindings_workspace_node_insert"
BEFORE INSERT ON "public"."agent_node_bindings"
FOR EACH ROW EXECUTE FUNCTION "public"."agent_node_bindings_workspace_node_insert"();
--> statement-breakpoint
CREATE FUNCTION "public"."agent_node_bindings_workspace_node_update"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "public"."nodes" n
    WHERE n."workspace_id" = NEW."workspace_id" AND n."id" = NEW."node_id"
  ) THEN
    RAISE EXCEPTION 'agent_node_bindings workspace/node mismatch' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "agent_node_bindings_workspace_node_update"
BEFORE UPDATE OF "workspace_id", "node_id" ON "public"."agent_node_bindings"
FOR EACH ROW EXECUTE FUNCTION "public"."agent_node_bindings_workspace_node_update"();
--> statement-breakpoint

-- ============================================
-- agents
-- ============================================
CREATE FUNCTION "public"."agents_clear_liveness_recovery"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE "public"."agents" SET "status_before_liveness_loss" = NULL WHERE "id" = NEW."id";
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "agents_clear_liveness_recovery"
AFTER UPDATE OF "status" ON "public"."agents"
FOR EACH ROW
WHEN (NEW."status_before_liveness_loss" IS NOT NULL
  AND NEW."status_before_liveness_loss" IS NOT DISTINCT FROM OLD."status_before_liveness_loss")
EXECUTE FUNCTION "public"."agents_clear_liveness_recovery"();
--> statement-breakpoint
CREATE FUNCTION "public"."agents_stamp_node_liveness_revision_insert"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE "public"."agents"
  SET "node_liveness_revision" = COALESCE((
    SELECT n."liveness_revision" + 1
    FROM "public"."nodes" n
    WHERE n."workspace_id" = NEW."workspace_id" AND n."id" = NEW."location_node_id"
  ), 1)
  WHERE "id" = NEW."id";
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "agents_stamp_node_liveness_revision_insert"
AFTER INSERT ON "public"."agents"
FOR EACH ROW
WHEN (NEW."location_type" = 'via_node' AND NEW."location_node_id" IS NOT NULL)
EXECUTE FUNCTION "public"."agents_stamp_node_liveness_revision_insert"();
--> statement-breakpoint
CREATE FUNCTION "public"."agents_stamp_node_liveness_revision_update"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE "public"."agents"
  SET "node_liveness_revision" = COALESCE((
    SELECT n."liveness_revision" + 1
    FROM "public"."nodes" n
    WHERE n."workspace_id" = NEW."workspace_id" AND n."id" = NEW."location_node_id"
  ), OLD."node_liveness_revision" + 1)
  WHERE "id" = NEW."id";
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "agents_stamp_node_liveness_revision_update"
AFTER UPDATE OF "status", "last_seen", "location_type", "location_node_id", "provider_name" ON "public"."agents"
FOR EACH ROW
WHEN (NEW."location_type" = 'via_node'
  AND NEW."location_node_id" IS NOT NULL
  AND NEW."node_liveness_revision" = OLD."node_liveness_revision")
EXECUTE FUNCTION "public"."agents_stamp_node_liveness_revision_update"();
--> statement-breakpoint
CREATE FUNCTION "public"."agents_status_reconciliation_timestamp"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE "public"."agents"
  SET "status_updated_at" = floor(extract(epoch from statement_timestamp()))::bigint
  WHERE "id" = NEW."id";
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "agents_status_reconciliation_timestamp"
AFTER UPDATE OF "status", "last_seen" ON "public"."agents"
FOR EACH ROW EXECUTE FUNCTION "public"."agents_status_reconciliation_timestamp"();
--> statement-breakpoint

-- ============================================
-- deliveries (sequence high-water invariant)
-- ============================================
CREATE FUNCTION "public"."deliveries_advance_sequence_high_water"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE "public"."agents"
  SET "delivery_seq" = GREATEST("delivery_seq", NEW."seq")
  WHERE "id" = NEW."agent_id" AND "workspace_id" = NEW."workspace_id";
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "deliveries_advance_sequence_high_water"
AFTER INSERT ON "public"."deliveries"
FOR EACH ROW EXECUTE FUNCTION "public"."deliveries_advance_sequence_high_water"();
--> statement-breakpoint

-- ============================================
-- files
-- ============================================
CREATE FUNCTION "public"."files_enqueue_object_cleanup"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  now_s bigint := floor(extract(epoch from statement_timestamp()))::bigint;
BEGIN
  INSERT INTO "public"."file_cleanup_queue" AS q ("storage_key", "delete_after")
  VALUES (OLD."storage_key", GREATEST(now_s, COALESCE(OLD."upload_expires_at", now_s + 3600)))
  ON CONFLICT ("storage_key") DO UPDATE SET
    "delete_after" = GREATEST(q."delete_after", EXCLUDED."delete_after");
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "files_enqueue_object_cleanup"
AFTER DELETE ON "public"."files"
FOR EACH ROW EXECUTE FUNCTION "public"."files_enqueue_object_cleanup"();
--> statement-breakpoint

-- ============================================
-- node_providers / nodes (liveness revisions)
-- ============================================
CREATE FUNCTION "public"."node_providers_stamp_liveness_revision_insert"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE "public"."node_providers"
  SET "liveness_revision" = COALESCE((
    SELECT n."liveness_revision" + 1
    FROM "public"."nodes" n
    WHERE n."workspace_id" = NEW."workspace_id" AND n."id" = NEW."node_id"
  ), 1)
  WHERE "id" = NEW."id";
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "node_providers_stamp_liveness_revision_insert"
AFTER INSERT ON "public"."node_providers"
FOR EACH ROW EXECUTE FUNCTION "public"."node_providers_stamp_liveness_revision_insert"();
--> statement-breakpoint
CREATE FUNCTION "public"."node_providers_stamp_liveness_revision_update"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE "public"."node_providers"
  SET "liveness_revision" = COALESCE((
    SELECT n."liveness_revision" + 1
    FROM "public"."nodes" n
    WHERE n."workspace_id" = NEW."workspace_id" AND n."id" = NEW."node_id"
  ), OLD."liveness_revision" + 1)
  WHERE "id" = NEW."id";
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "node_providers_stamp_liveness_revision_update"
AFTER UPDATE OF "status", "last_heartbeat_at", "instance_id" ON "public"."node_providers"
FOR EACH ROW
WHEN (NEW."liveness_revision" = OLD."liveness_revision")
EXECUTE FUNCTION "public"."node_providers_stamp_liveness_revision_update"();
--> statement-breakpoint
CREATE FUNCTION "public"."nodes_advance_liveness_revision"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE "public"."nodes" SET "liveness_revision" = OLD."liveness_revision" + 1 WHERE "id" = NEW."id";
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "nodes_advance_liveness_revision"
AFTER UPDATE OF "status", "last_heartbeat_at" ON "public"."nodes"
FOR EACH ROW
WHEN (NEW."liveness_revision" = OLD."liveness_revision")
EXECUTE FUNCTION "public"."nodes_advance_liveness_revision"();
--> statement-breakpoint

-- ============================================
-- Full-text mirrors (FTS5 external-content tables in SQLite)
-- ============================================
CREATE TABLE "public"."messages_fts" (
  "rowid" bigint PRIMARY KEY,
  "id" text,
  "body" text,
  "document" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce("body", ''))) STORED
);
--> statement-breakpoint
CREATE INDEX "messages_fts_document_idx" ON "public"."messages_fts" USING gin ("document");
--> statement-breakpoint
CREATE TABLE "public"."messages_mention_fts" (
  "rowid" bigint PRIMARY KEY,
  "workspace_id" text,
  "body" text,
  "document" tsvector GENERATED ALWAYS AS (
    to_tsvector('simple'::regconfig, coalesce("workspace_id", '') || ' ' || coalesce("body", ''))
  ) STORED
);
--> statement-breakpoint
CREATE INDEX "messages_mention_fts_document_idx" ON "public"."messages_mention_fts" USING gin ("document");
--> statement-breakpoint
CREATE TABLE "public"."directory_agents_fts" (
  "rowid" bigint PRIMARY KEY,
  "id" text,
  "name" text,
  "description" text,
  "provider" text,
  "tags" text,
  "document" tsvector GENERATED ALWAYS AS (
    to_tsvector('simple'::regconfig, coalesce("name", '') || ' ' || coalesce("description", '') || ' ' || coalesce("provider", '') || ' ' || coalesce("tags", ''))
  ) STORED
);
--> statement-breakpoint
CREATE INDEX "directory_agents_fts_document_idx" ON "public"."directory_agents_fts" USING gin ("document");
--> statement-breakpoint
CREATE TABLE "public"."directory_skills_fts" (
  "rowid" bigint PRIMARY KEY,
  "id" text,
  "directory_agent_id" text,
  "name" text,
  "description" text,
  "tags" text,
  "document" tsvector GENERATED ALWAYS AS (
    to_tsvector('simple'::regconfig, coalesce("name", '') || ' ' || coalesce("description", '') || ' ' || coalesce("tags", ''))
  ) STORED
);
--> statement-breakpoint
CREATE INDEX "directory_skills_fts_document_idx" ON "public"."directory_skills_fts" USING gin ("document");
--> statement-breakpoint

CREATE FUNCTION "public"."messages_fts_insert"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO "public"."messages_fts" ("rowid", "id", "body") VALUES (NEW."rowid", NEW."id", NEW."body");
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "messages_fts_insert"
AFTER INSERT ON "public"."messages"
FOR EACH ROW EXECUTE FUNCTION "public"."messages_fts_insert"();
--> statement-breakpoint
CREATE FUNCTION "public"."messages_fts_delete"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM "public"."messages_fts" WHERE "rowid" = OLD."rowid";
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "messages_fts_delete"
AFTER DELETE ON "public"."messages"
FOR EACH ROW EXECUTE FUNCTION "public"."messages_fts_delete"();
--> statement-breakpoint
CREATE FUNCTION "public"."messages_fts_update"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM "public"."messages_fts" WHERE "rowid" = OLD."rowid";
  INSERT INTO "public"."messages_fts" ("rowid", "id", "body") VALUES (NEW."rowid", NEW."id", NEW."body");
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "messages_fts_update"
AFTER UPDATE OF "body" ON "public"."messages"
FOR EACH ROW EXECUTE FUNCTION "public"."messages_fts_update"();
--> statement-breakpoint
CREATE FUNCTION "public"."messages_mention_fts_insert"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO "public"."messages_mention_fts" ("rowid", "workspace_id", "body")
  VALUES (NEW."rowid", NEW."workspace_id", NEW."body")
  ON CONFLICT ("rowid") DO NOTHING;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "messages_mention_fts_insert"
AFTER INSERT ON "public"."messages"
FOR EACH ROW EXECUTE FUNCTION "public"."messages_mention_fts_insert"();
--> statement-breakpoint
CREATE FUNCTION "public"."messages_mention_fts_delete"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM "public"."messages_mention_fts" WHERE "rowid" = OLD."rowid";
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "messages_mention_fts_delete"
AFTER DELETE ON "public"."messages"
FOR EACH ROW EXECUTE FUNCTION "public"."messages_mention_fts_delete"();
--> statement-breakpoint
CREATE FUNCTION "public"."messages_mention_fts_update"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM "public"."messages_mention_fts" WHERE "rowid" = OLD."rowid";
  INSERT INTO "public"."messages_mention_fts" ("rowid", "workspace_id", "body")
  VALUES (NEW."rowid", NEW."workspace_id", NEW."body")
  ON CONFLICT ("rowid") DO NOTHING;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "messages_mention_fts_update"
AFTER UPDATE OF "body", "workspace_id" ON "public"."messages"
FOR EACH ROW EXECUTE FUNCTION "public"."messages_mention_fts_update"();
--> statement-breakpoint
CREATE FUNCTION "public"."directory_agents_fts_insert"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO "public"."directory_agents_fts" ("rowid", "id", "name", "description", "provider", "tags")
  VALUES (NEW."rowid", NEW."id", NEW."name", COALESCE(NEW."description", ''), COALESCE(NEW."provider", ''), COALESCE(NEW."tags"::text, '[]'));
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "directory_agents_fts_insert"
AFTER INSERT ON "public"."directory_agents"
FOR EACH ROW EXECUTE FUNCTION "public"."directory_agents_fts_insert"();
--> statement-breakpoint
CREATE FUNCTION "public"."directory_agents_fts_delete"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM "public"."directory_agents_fts" WHERE "rowid" = OLD."rowid";
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "directory_agents_fts_delete"
AFTER DELETE ON "public"."directory_agents"
FOR EACH ROW EXECUTE FUNCTION "public"."directory_agents_fts_delete"();
--> statement-breakpoint
CREATE FUNCTION "public"."directory_agents_fts_update"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM "public"."directory_agents_fts" WHERE "rowid" = OLD."rowid";
  INSERT INTO "public"."directory_agents_fts" ("rowid", "id", "name", "description", "provider", "tags")
  VALUES (NEW."rowid", NEW."id", NEW."name", COALESCE(NEW."description", ''), COALESCE(NEW."provider", ''), COALESCE(NEW."tags"::text, '[]'));
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "directory_agents_fts_update"
AFTER UPDATE OF "name", "description", "provider", "tags" ON "public"."directory_agents"
FOR EACH ROW EXECUTE FUNCTION "public"."directory_agents_fts_update"();
--> statement-breakpoint
CREATE FUNCTION "public"."directory_skills_fts_insert"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO "public"."directory_skills_fts" ("rowid", "id", "directory_agent_id", "name", "description", "tags")
  VALUES (NEW."rowid", NEW."id", NEW."directory_agent_id", NEW."name", COALESCE(NEW."description", ''), COALESCE(NEW."tags"::text, '[]'));
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "directory_skills_fts_insert"
AFTER INSERT ON "public"."directory_skills"
FOR EACH ROW EXECUTE FUNCTION "public"."directory_skills_fts_insert"();
--> statement-breakpoint
CREATE FUNCTION "public"."directory_skills_fts_delete"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM "public"."directory_skills_fts" WHERE "rowid" = OLD."rowid";
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "directory_skills_fts_delete"
AFTER DELETE ON "public"."directory_skills"
FOR EACH ROW EXECUTE FUNCTION "public"."directory_skills_fts_delete"();
--> statement-breakpoint
CREATE FUNCTION "public"."directory_skills_fts_update"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM "public"."directory_skills_fts" WHERE "rowid" = OLD."rowid";
  INSERT INTO "public"."directory_skills_fts" ("rowid", "id", "directory_agent_id", "name", "description", "tags")
  VALUES (NEW."rowid", NEW."id", NEW."directory_agent_id", NEW."name", COALESCE(NEW."description", ''), COALESCE(NEW."tags"::text, '[]'));
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "directory_skills_fts_update"
AFTER UPDATE OF "name", "description", "tags" ON "public"."directory_skills"
FOR EACH ROW EXECUTE FUNCTION "public"."directory_skills_fts_update"();
