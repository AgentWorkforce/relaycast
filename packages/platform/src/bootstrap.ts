import { sql } from "drizzle-orm";
import type { PlatformDb, ProductRegistrationInput } from "./client.js";
import { registerProduct } from "./client.js";

// Default seed data for first-run bootstrap. Tables themselves are created
// by Drizzle migrations (packages/web/drizzle/*.sql). This module only
// seeds rows once per environment — the migration handles DDL.
export const DEFAULT_PLATFORM_PRODUCTS: ProductRegistrationInput[] = [
  {
    id: "sage",
    displayName: "Sage",
  },
  {
    id: "my-senior-dev",
    displayName: "My Senior Dev",
  },
  {
    id: "nightcto",
    displayName: "NightCTO",
  },
];

export interface BootstrapPlatformOptions {
  seedProducts?: ProductRegistrationInput[];
}

export interface BootstrapPlatformResult {
  seededProducts: string[];
  wasFirstRun: boolean;
}

/**
 * Idempotent seed helper. Assumes the `platform_products`,
 * `workspace_platform_policies`, and `workspace_platform_access` tables
 * already exist (created by Drizzle migrations on deploy).
 *
 * Call from an ops script or a manual admin endpoint — not from hot
 * request paths. Re-running is a no-op once rows are seeded.
 */
export async function bootstrapPlatform(
  db: PlatformDb,
  options: BootstrapPlatformOptions = {},
): Promise<BootstrapPlatformResult> {
  const countResult = await db.execute<{ count: number }>(
    sql`select count(*)::int as count from platform_products`,
  );
  const countRow = countResult.rows[0];
  const productCount = Number(countRow?.count ?? 0);
  const wasFirstRun = productCount === 0;

  const seededProducts: string[] = [];
  if (wasFirstRun) {
    for (const product of options.seedProducts ?? DEFAULT_PLATFORM_PRODUCTS) {
      const record = await registerProduct(db, product);
      seededProducts.push(record.id);
    }
  }

  return {
    seededProducts,
    wasFirstRun,
  };
}
