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
CREATE FUNCTION "relaycast"."a2a_inbound_source_prune"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE "relaycast"."a2a_inbound" SET "response" = NULL WHERE "message_id" = OLD."id";
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "a2a_inbound_source_prune"
BEFORE DELETE ON "relaycast"."messages"
FOR EACH ROW EXECUTE FUNCTION "relaycast"."a2a_inbound_source_prune"();
--> statement-breakpoint

-- ============================================
-- action_invocations
-- ============================================
CREATE FUNCTION "relaycast"."action_invocations_stamp_node_liveness_revision_insert"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE "relaycast"."action_invocations"
  SET "node_liveness_revision" = COALESCE((
    SELECT n."liveness_revision" + 1
    FROM "relaycast"."nodes" n
    WHERE n."workspace_id" = NEW."workspace_id" AND n."id" = NEW."dispatched_node_id"
  ), 1)
  WHERE "id" = NEW."id";
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "action_invocations_stamp_node_liveness_revision_insert"
AFTER INSERT ON "relaycast"."action_invocations"
FOR EACH ROW
WHEN (NEW."dispatched_node_id" IS NOT NULL)
EXECUTE FUNCTION "relaycast"."action_invocations_stamp_node_liveness_revision_insert"();
--> statement-breakpoint
CREATE FUNCTION "relaycast"."action_invocations_stamp_node_liveness_revision_update"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE "relaycast"."action_invocations"
  SET "node_liveness_revision" = COALESCE((
    SELECT n."liveness_revision" + 1
    FROM "relaycast"."nodes" n
    WHERE n."workspace_id" = NEW."workspace_id" AND n."id" = NEW."dispatched_node_id"
  ), OLD."node_liveness_revision" + 1)
  WHERE "id" = NEW."id";
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "action_invocations_stamp_node_liveness_revision_update"
AFTER UPDATE OF "status", "dispatched_node_id", "dispatched_at", "dispatch_attempts" ON "relaycast"."action_invocations"
FOR EACH ROW
WHEN (NEW."dispatched_node_id" IS NOT NULL AND NEW."node_liveness_revision" = OLD."node_liveness_revision")
EXECUTE FUNCTION "relaycast"."action_invocations_stamp_node_liveness_revision_update"();
--> statement-breakpoint

-- ============================================
-- agent_node_bindings
-- ============================================
CREATE FUNCTION "relaycast"."agent_node_bindings_workspace_agent_insert"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "relaycast"."agents" a
    WHERE a."workspace_id" = NEW."workspace_id" AND a."id" = NEW."agent_id"
  ) THEN
    RAISE EXCEPTION 'agent_node_bindings workspace/agent mismatch' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "agent_node_bindings_workspace_agent_insert"
BEFORE INSERT ON "relaycast"."agent_node_bindings"
FOR EACH ROW EXECUTE FUNCTION "relaycast"."agent_node_bindings_workspace_agent_insert"();
--> statement-breakpoint
CREATE FUNCTION "relaycast"."agent_node_bindings_workspace_agent_update"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "relaycast"."agents" a
    WHERE a."workspace_id" = NEW."workspace_id" AND a."id" = NEW."agent_id"
  ) THEN
    RAISE EXCEPTION 'agent_node_bindings workspace/agent mismatch' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "agent_node_bindings_workspace_agent_update"
BEFORE UPDATE OF "workspace_id", "agent_id" ON "relaycast"."agent_node_bindings"
FOR EACH ROW EXECUTE FUNCTION "relaycast"."agent_node_bindings_workspace_agent_update"();
--> statement-breakpoint
CREATE FUNCTION "relaycast"."agent_node_bindings_workspace_node_insert"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "relaycast"."nodes" n
    WHERE n."workspace_id" = NEW."workspace_id" AND n."id" = NEW."node_id"
  ) THEN
    RAISE EXCEPTION 'agent_node_bindings workspace/node mismatch' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "agent_node_bindings_workspace_node_insert"
BEFORE INSERT ON "relaycast"."agent_node_bindings"
FOR EACH ROW EXECUTE FUNCTION "relaycast"."agent_node_bindings_workspace_node_insert"();
--> statement-breakpoint
CREATE FUNCTION "relaycast"."agent_node_bindings_workspace_node_update"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "relaycast"."nodes" n
    WHERE n."workspace_id" = NEW."workspace_id" AND n."id" = NEW."node_id"
  ) THEN
    RAISE EXCEPTION 'agent_node_bindings workspace/node mismatch' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "agent_node_bindings_workspace_node_update"
BEFORE UPDATE OF "workspace_id", "node_id" ON "relaycast"."agent_node_bindings"
FOR EACH ROW EXECUTE FUNCTION "relaycast"."agent_node_bindings_workspace_node_update"();
--> statement-breakpoint

-- ============================================
-- agents
-- ============================================
CREATE FUNCTION "relaycast"."agents_clear_liveness_recovery"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE "relaycast"."agents" SET "status_before_liveness_loss" = NULL WHERE "id" = NEW."id";
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "agents_clear_liveness_recovery"
AFTER UPDATE OF "status" ON "relaycast"."agents"
FOR EACH ROW
WHEN (NEW."status_before_liveness_loss" IS NOT NULL
  AND NEW."status_before_liveness_loss" IS NOT DISTINCT FROM OLD."status_before_liveness_loss")
EXECUTE FUNCTION "relaycast"."agents_clear_liveness_recovery"();
--> statement-breakpoint
CREATE FUNCTION "relaycast"."agents_stamp_node_liveness_revision_insert"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE "relaycast"."agents"
  SET "node_liveness_revision" = COALESCE((
    SELECT n."liveness_revision" + 1
    FROM "relaycast"."nodes" n
    WHERE n."workspace_id" = NEW."workspace_id" AND n."id" = NEW."location_node_id"
  ), 1)
  WHERE "id" = NEW."id";
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "agents_stamp_node_liveness_revision_insert"
AFTER INSERT ON "relaycast"."agents"
FOR EACH ROW
WHEN (NEW."location_type" = 'via_node' AND NEW."location_node_id" IS NOT NULL)
EXECUTE FUNCTION "relaycast"."agents_stamp_node_liveness_revision_insert"();
--> statement-breakpoint
CREATE FUNCTION "relaycast"."agents_stamp_node_liveness_revision_update"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE "relaycast"."agents"
  SET "node_liveness_revision" = COALESCE((
    SELECT n."liveness_revision" + 1
    FROM "relaycast"."nodes" n
    WHERE n."workspace_id" = NEW."workspace_id" AND n."id" = NEW."location_node_id"
  ), OLD."node_liveness_revision" + 1)
  WHERE "id" = NEW."id";
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "agents_stamp_node_liveness_revision_update"
AFTER UPDATE OF "status", "last_seen", "location_type", "location_node_id", "provider_name" ON "relaycast"."agents"
FOR EACH ROW
WHEN (NEW."location_type" = 'via_node'
  AND NEW."location_node_id" IS NOT NULL
  AND NEW."node_liveness_revision" = OLD."node_liveness_revision")
EXECUTE FUNCTION "relaycast"."agents_stamp_node_liveness_revision_update"();
--> statement-breakpoint
CREATE FUNCTION "relaycast"."agents_status_reconciliation_timestamp"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE "relaycast"."agents"
  SET "status_updated_at" = floor(extract(epoch from statement_timestamp()))::bigint
  WHERE "id" = NEW."id";
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "agents_status_reconciliation_timestamp"
AFTER UPDATE OF "status", "last_seen" ON "relaycast"."agents"
FOR EACH ROW EXECUTE FUNCTION "relaycast"."agents_status_reconciliation_timestamp"();
--> statement-breakpoint

-- ============================================
-- deliveries (sequence high-water invariant)
-- ============================================
CREATE FUNCTION "relaycast"."deliveries_advance_sequence_high_water"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE "relaycast"."agents"
  SET "delivery_seq" = GREATEST("delivery_seq", NEW."seq")
  WHERE "id" = NEW."agent_id" AND "workspace_id" = NEW."workspace_id";
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "deliveries_advance_sequence_high_water"
AFTER INSERT ON "relaycast"."deliveries"
FOR EACH ROW EXECUTE FUNCTION "relaycast"."deliveries_advance_sequence_high_water"();
--> statement-breakpoint

-- ============================================
-- files
-- ============================================
CREATE FUNCTION "relaycast"."files_enqueue_object_cleanup"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  now_s bigint := floor(extract(epoch from statement_timestamp()))::bigint;
BEGIN
  INSERT INTO "relaycast"."file_cleanup_queue" AS q ("storage_key", "delete_after")
  VALUES (OLD."storage_key", GREATEST(now_s, COALESCE(OLD."upload_expires_at", now_s + 3600)))
  ON CONFLICT ("storage_key") DO UPDATE SET
    "delete_after" = GREATEST(q."delete_after", EXCLUDED."delete_after");
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "files_enqueue_object_cleanup"
AFTER DELETE ON "relaycast"."files"
FOR EACH ROW EXECUTE FUNCTION "relaycast"."files_enqueue_object_cleanup"();
--> statement-breakpoint

-- ============================================
-- node_providers / nodes (liveness revisions)
-- ============================================
CREATE FUNCTION "relaycast"."node_providers_stamp_liveness_revision_insert"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE "relaycast"."node_providers"
  SET "liveness_revision" = COALESCE((
    SELECT n."liveness_revision" + 1
    FROM "relaycast"."nodes" n
    WHERE n."workspace_id" = NEW."workspace_id" AND n."id" = NEW."node_id"
  ), 1)
  WHERE "id" = NEW."id";
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "node_providers_stamp_liveness_revision_insert"
AFTER INSERT ON "relaycast"."node_providers"
FOR EACH ROW EXECUTE FUNCTION "relaycast"."node_providers_stamp_liveness_revision_insert"();
--> statement-breakpoint
CREATE FUNCTION "relaycast"."node_providers_stamp_liveness_revision_update"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE "relaycast"."node_providers"
  SET "liveness_revision" = COALESCE((
    SELECT n."liveness_revision" + 1
    FROM "relaycast"."nodes" n
    WHERE n."workspace_id" = NEW."workspace_id" AND n."id" = NEW."node_id"
  ), OLD."liveness_revision" + 1)
  WHERE "id" = NEW."id";
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "node_providers_stamp_liveness_revision_update"
AFTER UPDATE OF "status", "last_heartbeat_at", "instance_id" ON "relaycast"."node_providers"
FOR EACH ROW
WHEN (NEW."liveness_revision" = OLD."liveness_revision")
EXECUTE FUNCTION "relaycast"."node_providers_stamp_liveness_revision_update"();
--> statement-breakpoint
CREATE FUNCTION "relaycast"."nodes_advance_liveness_revision"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE "relaycast"."nodes" SET "liveness_revision" = OLD."liveness_revision" + 1 WHERE "id" = NEW."id";
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "nodes_advance_liveness_revision"
AFTER UPDATE OF "status", "last_heartbeat_at" ON "relaycast"."nodes"
FOR EACH ROW
WHEN (NEW."liveness_revision" = OLD."liveness_revision")
EXECUTE FUNCTION "relaycast"."nodes_advance_liveness_revision"();
--> statement-breakpoint

-- ============================================
-- Full-text mirrors (FTS5 external-content tables in SQLite)
-- ============================================
CREATE TABLE "relaycast"."messages_fts" (
  "rowid" bigint PRIMARY KEY,
  "id" text,
  "body" text,
  "document" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce("body", ''))) STORED
);
--> statement-breakpoint
CREATE INDEX "messages_fts_document_idx" ON "relaycast"."messages_fts" USING gin ("document");
--> statement-breakpoint
CREATE TABLE "relaycast"."messages_mention_fts" (
  "rowid" bigint PRIMARY KEY,
  "workspace_id" text,
  "body" text,
  "document" tsvector GENERATED ALWAYS AS (
    to_tsvector('simple'::regconfig, coalesce("workspace_id", '') || ' ' || coalesce("body", ''))
  ) STORED
);
--> statement-breakpoint
CREATE INDEX "messages_mention_fts_document_idx" ON "relaycast"."messages_mention_fts" USING gin ("document");
--> statement-breakpoint
CREATE TABLE "relaycast"."directory_agents_fts" (
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
CREATE INDEX "directory_agents_fts_document_idx" ON "relaycast"."directory_agents_fts" USING gin ("document");
--> statement-breakpoint
CREATE TABLE "relaycast"."directory_skills_fts" (
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
CREATE INDEX "directory_skills_fts_document_idx" ON "relaycast"."directory_skills_fts" USING gin ("document");
--> statement-breakpoint

CREATE FUNCTION "relaycast"."messages_fts_insert"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO "relaycast"."messages_fts" ("rowid", "id", "body") VALUES (NEW."rowid", NEW."id", NEW."body");
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "messages_fts_insert"
AFTER INSERT ON "relaycast"."messages"
FOR EACH ROW EXECUTE FUNCTION "relaycast"."messages_fts_insert"();
--> statement-breakpoint
CREATE FUNCTION "relaycast"."messages_fts_delete"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM "relaycast"."messages_fts" WHERE "rowid" = OLD."rowid";
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "messages_fts_delete"
AFTER DELETE ON "relaycast"."messages"
FOR EACH ROW EXECUTE FUNCTION "relaycast"."messages_fts_delete"();
--> statement-breakpoint
CREATE FUNCTION "relaycast"."messages_fts_update"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM "relaycast"."messages_fts" WHERE "rowid" = OLD."rowid";
  INSERT INTO "relaycast"."messages_fts" ("rowid", "id", "body") VALUES (NEW."rowid", NEW."id", NEW."body");
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "messages_fts_update"
AFTER UPDATE OF "body" ON "relaycast"."messages"
FOR EACH ROW EXECUTE FUNCTION "relaycast"."messages_fts_update"();
--> statement-breakpoint
CREATE FUNCTION "relaycast"."messages_mention_fts_insert"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO "relaycast"."messages_mention_fts" ("rowid", "workspace_id", "body")
  VALUES (NEW."rowid", NEW."workspace_id", NEW."body")
  ON CONFLICT ("rowid") DO NOTHING;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "messages_mention_fts_insert"
AFTER INSERT ON "relaycast"."messages"
FOR EACH ROW EXECUTE FUNCTION "relaycast"."messages_mention_fts_insert"();
--> statement-breakpoint
CREATE FUNCTION "relaycast"."messages_mention_fts_delete"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM "relaycast"."messages_mention_fts" WHERE "rowid" = OLD."rowid";
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "messages_mention_fts_delete"
AFTER DELETE ON "relaycast"."messages"
FOR EACH ROW EXECUTE FUNCTION "relaycast"."messages_mention_fts_delete"();
--> statement-breakpoint
CREATE FUNCTION "relaycast"."messages_mention_fts_update"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM "relaycast"."messages_mention_fts" WHERE "rowid" = OLD."rowid";
  INSERT INTO "relaycast"."messages_mention_fts" ("rowid", "workspace_id", "body")
  VALUES (NEW."rowid", NEW."workspace_id", NEW."body")
  ON CONFLICT ("rowid") DO NOTHING;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "messages_mention_fts_update"
AFTER UPDATE OF "body", "workspace_id" ON "relaycast"."messages"
FOR EACH ROW EXECUTE FUNCTION "relaycast"."messages_mention_fts_update"();
--> statement-breakpoint
CREATE FUNCTION "relaycast"."directory_agents_fts_insert"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO "relaycast"."directory_agents_fts" ("rowid", "id", "name", "description", "provider", "tags")
  VALUES (NEW."rowid", NEW."id", NEW."name", COALESCE(NEW."description", ''), COALESCE(NEW."provider", ''), COALESCE(NEW."tags"::text, '[]'));
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "directory_agents_fts_insert"
AFTER INSERT ON "relaycast"."directory_agents"
FOR EACH ROW EXECUTE FUNCTION "relaycast"."directory_agents_fts_insert"();
--> statement-breakpoint
CREATE FUNCTION "relaycast"."directory_agents_fts_delete"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM "relaycast"."directory_agents_fts" WHERE "rowid" = OLD."rowid";
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "directory_agents_fts_delete"
AFTER DELETE ON "relaycast"."directory_agents"
FOR EACH ROW EXECUTE FUNCTION "relaycast"."directory_agents_fts_delete"();
--> statement-breakpoint
CREATE FUNCTION "relaycast"."directory_agents_fts_update"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM "relaycast"."directory_agents_fts" WHERE "rowid" = OLD."rowid";
  INSERT INTO "relaycast"."directory_agents_fts" ("rowid", "id", "name", "description", "provider", "tags")
  VALUES (NEW."rowid", NEW."id", NEW."name", COALESCE(NEW."description", ''), COALESCE(NEW."provider", ''), COALESCE(NEW."tags"::text, '[]'));
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "directory_agents_fts_update"
AFTER UPDATE OF "name", "description", "provider", "tags" ON "relaycast"."directory_agents"
FOR EACH ROW EXECUTE FUNCTION "relaycast"."directory_agents_fts_update"();
--> statement-breakpoint
CREATE FUNCTION "relaycast"."directory_skills_fts_insert"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO "relaycast"."directory_skills_fts" ("rowid", "id", "directory_agent_id", "name", "description", "tags")
  VALUES (NEW."rowid", NEW."id", NEW."directory_agent_id", NEW."name", COALESCE(NEW."description", ''), COALESCE(NEW."tags"::text, '[]'));
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "directory_skills_fts_insert"
AFTER INSERT ON "relaycast"."directory_skills"
FOR EACH ROW EXECUTE FUNCTION "relaycast"."directory_skills_fts_insert"();
--> statement-breakpoint
CREATE FUNCTION "relaycast"."directory_skills_fts_delete"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM "relaycast"."directory_skills_fts" WHERE "rowid" = OLD."rowid";
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "directory_skills_fts_delete"
AFTER DELETE ON "relaycast"."directory_skills"
FOR EACH ROW EXECUTE FUNCTION "relaycast"."directory_skills_fts_delete"();
--> statement-breakpoint
CREATE FUNCTION "relaycast"."directory_skills_fts_update"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM "relaycast"."directory_skills_fts" WHERE "rowid" = OLD."rowid";
  INSERT INTO "relaycast"."directory_skills_fts" ("rowid", "id", "directory_agent_id", "name", "description", "tags")
  VALUES (NEW."rowid", NEW."id", NEW."directory_agent_id", NEW."name", COALESCE(NEW."description", ''), COALESCE(NEW."tags"::text, '[]'));
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "directory_skills_fts_update"
AFTER UPDATE OF "name", "description", "tags" ON "relaycast"."directory_skills"
FOR EACH ROW EXECUTE FUNCTION "relaycast"."directory_skills_fts_update"();
