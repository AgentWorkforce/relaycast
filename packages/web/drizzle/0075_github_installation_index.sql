CREATE TABLE IF NOT EXISTS "github_installations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "installation_id" text NOT NULL,
  "account_type" text NOT NULL DEFAULT 'unknown',
  "account_login" text,
  "account_id" text,
  "repository_selection" text NOT NULL DEFAULT 'unknown',
  "permissions_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "events" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "suspended" boolean NOT NULL DEFAULT false,
  "suspended_at" timestamp with time zone,
  "suspended_by" text,
  "installed_by_user_id" uuid,
  "provider_config_key" text,
  "connection_id" text,
  "metadata_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "github_installations_account_type_check"
    CHECK ("account_type" IN ('User','Organization','unknown')),
  CONSTRAINT "github_installations_repository_selection_check"
    CHECK ("repository_selection" IN ('all','selected','unknown'))
);

DO $$ BEGIN
  ALTER TABLE "github_installations"
    ADD CONSTRAINT "github_installations_installed_by_user_id_users_id_fk"
    FOREIGN KEY ("installed_by_user_id")
    REFERENCES "users"("id")
    ON DELETE SET NULL
    ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "github_installations_installation_id_unique"
  ON "github_installations" USING btree ("installation_id");

CREATE INDEX IF NOT EXISTS "idx_github_installations_account"
  ON "github_installations" USING btree ("account_login","account_id");

CREATE TABLE IF NOT EXISTS "workspace_github_installation_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- Matches workspace_integrations.workspace_id. Productized workspaces can
  -- be rw_<8hex>; UUID FK to workspaces is deferred to workspace-id unification.
  "workspace_id" text NOT NULL,
  "installation_id" text NOT NULL,
  "linked_by_user_id" uuid,
  "workspace_integration_id" uuid,
  "connection_id" text,
  "provider_config_key" text,
  "metadata_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE "workspace_github_installation_links"
    ADD CONSTRAINT "workspace_github_installation_links_installation_id_fk"
    FOREIGN KEY ("installation_id")
    REFERENCES "github_installations"("installation_id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "workspace_github_installation_links"
    ADD CONSTRAINT "workspace_github_installation_links_linked_by_user_id_users_id_fk"
    FOREIGN KEY ("linked_by_user_id")
    REFERENCES "users"("id")
    ON DELETE SET NULL
    ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "workspace_github_installation_links"
    ADD CONSTRAINT "workspace_github_installation_links_workspace_integration_id_fk"
    FOREIGN KEY ("workspace_integration_id")
    REFERENCES "workspace_integrations"("id")
    ON DELETE SET NULL
    ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_github_installation_links_workspace_installation_unique"
  ON "workspace_github_installation_links" USING btree ("workspace_id","installation_id");

CREATE INDEX IF NOT EXISTS "idx_workspace_github_installation_links_workspace"
  ON "workspace_github_installation_links" USING btree ("workspace_id");

CREATE INDEX IF NOT EXISTS "idx_workspace_github_installation_links_installation"
  ON "workspace_github_installation_links" USING btree ("installation_id");

CREATE TABLE IF NOT EXISTS "repo_github_installation_index" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- Matches workspace_integrations.workspace_id; see link table comment.
  "workspace_id" text NOT NULL,
  "installation_id" text NOT NULL,
  "repo_owner" text NOT NULL,
  "repo_name" text NOT NULL,
  "repo_id" text,
  "access_state" text NOT NULL DEFAULT 'active',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "repo_github_installation_index_access_state_check"
    CHECK ("access_state" IN ('active','access_removed','unknown'))
);

DO $$ BEGIN
  ALTER TABLE "repo_github_installation_index"
    ADD CONSTRAINT "repo_github_installation_index_installation_id_fk"
    FOREIGN KEY ("installation_id")
    REFERENCES "github_installations"("installation_id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "repo_github_installation_index_workspace_repo_unique"
  ON "repo_github_installation_index" USING btree ("workspace_id","repo_owner","repo_name");

CREATE INDEX IF NOT EXISTS "idx_repo_github_installation_index_workspace"
  ON "repo_github_installation_index" USING btree ("workspace_id");

CREATE INDEX IF NOT EXISTS "idx_repo_github_installation_index_installation"
  ON "repo_github_installation_index" USING btree ("workspace_id","installation_id");

CREATE INDEX IF NOT EXISTS "idx_repo_github_installation_index_access_state"
  ON "repo_github_installation_index" USING btree ("workspace_id","access_state");
