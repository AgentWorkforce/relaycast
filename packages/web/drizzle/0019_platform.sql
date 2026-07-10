CREATE TABLE IF NOT EXISTS "platform_products" (
  "id" text PRIMARY KEY,
  "display_name" text NOT NULL,
  "description" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "workspace_platform_policies" (
  "workspace_id" text PRIMARY KEY,
  "enforce_product_scope" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "workspace_platform_access" (
  "workspace_id" text NOT NULL,
  "product_id" text NOT NULL REFERENCES "platform_products"("id") ON DELETE CASCADE,
  "granted_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_platform_access_workspace_id_product_id_pk" PRIMARY KEY ("workspace_id", "product_id")
);

CREATE INDEX IF NOT EXISTS "idx_platform_products_display_name" ON "platform_products"("display_name");
CREATE INDEX IF NOT EXISTS "idx_workspace_platform_access_workspace" ON "workspace_platform_access"("workspace_id");
CREATE INDEX IF NOT EXISTS "idx_workspace_platform_access_product" ON "workspace_platform_access"("product_id");
