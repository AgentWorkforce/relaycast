CREATE TABLE "users" (
  "id" uuid PRIMARY KEY NOT NULL,
  "primary_email" text,
  "name" text,
  "avatar_url" text,
  "last_organization_id" uuid,
  "last_workspace_id" uuid,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);

CREATE TABLE "auth_identities" (
  "id" uuid PRIMARY KEY NOT NULL,
  "user_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "provider_user_id" text NOT NULL,
  "email" text,
  "email_verified" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);

CREATE UNIQUE INDEX "auth_identities_provider_user_unique"
  ON "auth_identities" ("provider", "provider_user_id");
CREATE INDEX "idx_auth_identities_user" ON "auth_identities" ("user_id");

CREATE TABLE "organizations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "created_by_user_id" uuid NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);

CREATE UNIQUE INDEX "organizations_slug_unique" ON "organizations" ("slug");

CREATE TABLE "organization_memberships" (
  "organization_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "role" text NOT NULL,
  "status" text NOT NULL,
  "joined_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("organization_id", "user_id")
);

CREATE INDEX "idx_memberships_user" ON "organization_memberships" ("user_id");

CREATE TABLE "workspaces" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" uuid NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);

CREATE UNIQUE INDEX "workspaces_org_slug_unique"
  ON "workspaces" ("organization_id", "slug");
CREATE INDEX "idx_workspaces_org" ON "workspaces" ("organization_id");
