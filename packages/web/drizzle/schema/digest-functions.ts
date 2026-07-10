// Canonical Drizzle declarations for the workspace_digest_functions storage
// layer. The parent ricky M1 workflow scopes this child to
// packages/web/drizzle/schema/**, so the table definitions live in the
// bridge file itself rather than in packages/web/lib/db/schema.ts.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users, workspaces } from "@cloud/core/db/schema.js";

const timestampColumn = (name: string) => timestamp(name, { withTimezone: true });
const uuidColumn = (name: string) => uuid(name);

export const workspaceDigestFunctions = pgTable(
  "workspace_digest_functions",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    workspaceId: uuidColumn("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    displayName: text("display_name"),
    status: text("status").notNull().default("active").$type<"active" | "disabled">(),
    runtime: text("runtime").notNull().default("node20"),
    entrypoint: text("entrypoint").notNull(),
    sourceHash: text("source_hash").notNull(),
    sourceSize: integer("source_size").notNull(),
    compiledArtifactRef: text("compiled_artifact_ref").notNull(),
    signature: text("signature").notNull(),
    signingKeyId: text("signing_key_id").notNull(),
    deployedByUserId: uuidColumn("deployed_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    disabledAt: timestampColumn("disabled_at"),
    disabledByUserId: uuidColumn("disabled_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    lastInvokedAt: timestampColumn("last_invoked_at"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    statusCheck: check(
      "workspace_digest_functions_status_valid",
      sql`${table.status} IN ('active', 'disabled')`,
    ),
    workspaceSlugLiveUnique: uniqueIndex(
      "workspace_digest_functions_workspace_slug_live_unique",
    )
      .on(table.workspaceId, table.slug)
      .where(sql`${table.status} <> 'disabled'`),
    workspaceStatusIndex: index(
      "idx_workspace_digest_functions_workspace_status",
    ).on(table.workspaceId, table.status),
    sourceHashIndex: index("idx_workspace_digest_functions_source_hash").on(
      table.sourceHash,
    ),
  }),
);
