-- Port of SQLite's messages_owner_approval_immutable (0087): once a message
-- is written, its owner_approval can never change, be cleared or be added.
CREATE FUNCTION "public"."messages_owner_approval_immutable"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'owner_approval is immutable' USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "messages_owner_approval_immutable"
BEFORE UPDATE OF "owner_approval" ON "public"."messages"
FOR EACH ROW WHEN (OLD."owner_approval" IS DISTINCT FROM NEW."owner_approval")
EXECUTE FUNCTION "public"."messages_owner_approval_immutable"();
