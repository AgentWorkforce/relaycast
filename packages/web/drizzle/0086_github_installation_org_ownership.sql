CREATE TABLE IF NOT EXISTS "organization_github_installations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "installation_id" text NOT NULL,
  "is_primary" boolean DEFAULT true NOT NULL,
  "linked_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "organization_join_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "source" text DEFAULT 'github_org' NOT NULL,
  "github_account_login" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "decided_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "github_join_policy" text DEFAULT 'request_approve' NOT NULL;

DO $$ BEGIN
  ALTER TABLE "organizations"
    ADD CONSTRAINT "organizations_github_join_policy_check"
    CHECK ("github_join_policy" IN ('off', 'request_approve', 'verified_domain', 'sso'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "github_verified_domains" text[] DEFAULT ARRAY[]::text[] NOT NULL;

ALTER TABLE "workspace_integrations" ALTER COLUMN "connection_id" DROP NOT NULL;

DROP INDEX IF EXISTS "workspace_integrations_provider_connection_unique";

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_integrations_provider_connection_unique"
  ON "workspace_integrations" USING btree ("provider", "connection_id")
  WHERE "provider" <> 'github';

DO $$ BEGIN
  ALTER TABLE "workspace_integrations"
    ADD CONSTRAINT "workspace_integrations_connection_required_except_github"
    CHECK ("connection_id" IS NOT NULL OR "provider" = 'github');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "organization_github_installations_org_installation_unique"
  ON "organization_github_installations" USING btree ("organization_id", "installation_id");

CREATE UNIQUE INDEX IF NOT EXISTS "organization_github_installations_org_primary_unique"
  ON "organization_github_installations" USING btree ("organization_id")
  WHERE "is_primary";

CREATE INDEX IF NOT EXISTS "idx_organization_github_installations_installation"
  ON "organization_github_installations" USING btree ("installation_id");

CREATE UNIQUE INDEX IF NOT EXISTS "organization_join_requests_open_unique"
  ON "organization_join_requests" USING btree ("organization_id", "user_id")
  WHERE "status" = 'pending';

CREATE INDEX IF NOT EXISTS "idx_organization_join_requests_user"
  ON "organization_join_requests" USING btree ("user_id");

DO $$ BEGIN
  ALTER TABLE "organization_github_installations"
    ADD CONSTRAINT "organization_github_installations_organization_id_fk"
    FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "organization_github_installations"
    ADD CONSTRAINT "organization_github_installations_installation_id_fk"
    FOREIGN KEY ("installation_id")
    REFERENCES "github_installations"("installation_id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "organization_github_installations"
    ADD CONSTRAINT "organization_github_installations_linked_by_user_id_fk"
    FOREIGN KEY ("linked_by_user_id")
    REFERENCES "users"("id")
    ON DELETE SET NULL
    ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "organization_join_requests"
    ADD CONSTRAINT "organization_join_requests_organization_id_fk"
    FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "organization_join_requests"
    ADD CONSTRAINT "organization_join_requests_user_id_fk"
    FOREIGN KEY ("user_id")
    REFERENCES "users"("id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "organization_join_requests"
    ADD CONSTRAINT "organization_join_requests_decided_by_user_id_fk"
    FOREIGN KEY ("decided_by_user_id")
    REFERENCES "users"("id")
    ON DELETE SET NULL
    ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
