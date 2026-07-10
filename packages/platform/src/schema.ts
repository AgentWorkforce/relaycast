import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { boolean, index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

const timestampColumn = (name: string) => timestamp(name, { withTimezone: true });

export const platformProducts = pgTable(
  "platform_products",
  {
    id: text("id").primaryKey(),
    displayName: text("display_name").notNull(),
    description: text("description"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    displayNameIndex: index("idx_platform_products_display_name").on(table.displayName),
  }),
);

export const workspacePlatformPolicies = pgTable("workspace_platform_policies", {
  workspaceId: text("workspace_id").primaryKey(),
  enforceProductScope: boolean("enforce_product_scope").notNull().default(false),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
  updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
});

export const workspacePlatformAccess = pgTable(
  "workspace_platform_access",
  {
    workspaceId: text("workspace_id").notNull(),
    productId: text("product_id")
      .notNull()
      .references(() => platformProducts.id, { onDelete: "cascade" }),
    grantedAt: timestampColumn("granted_at").notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.workspaceId, table.productId] }),
    workspaceIndex: index("idx_workspace_platform_access_workspace").on(table.workspaceId),
    productIndex: index("idx_workspace_platform_access_product").on(table.productId),
  }),
);

export type PlatformProduct = InferSelectModel<typeof platformProducts>;
export type NewPlatformProduct = InferInsertModel<typeof platformProducts>;
export type WorkspacePlatformPolicyRecord = InferSelectModel<typeof workspacePlatformPolicies>;
export type NewWorkspacePlatformPolicyRecord = InferInsertModel<typeof workspacePlatformPolicies>;
export type WorkspacePlatformAccessRecord = InferSelectModel<typeof workspacePlatformAccess>;
export type NewWorkspacePlatformAccessRecord = InferInsertModel<typeof workspacePlatformAccess>;

export interface WorkspacePolicy {
  workspaceId: string;
  enforceProductScope: boolean;
  allowedProductIds: string[];
  productScopes?: Record<string, string[]>;
}
