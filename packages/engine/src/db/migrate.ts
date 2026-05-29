/**
 * D1 migrations are applied via `wrangler d1 migrations apply`.
 *
 * For local development:
 *   npx wrangler d1 migrations apply relaycast --local
 *
 * For production/staging:
 *   npx wrangler d1 migrations apply relaycast --remote
 *
 * Generate new migrations after schema changes:
 *   npx drizzle-kit generate
 */
export async function runMigrations(): Promise<void> {
  console.log('D1 migrations are applied via `wrangler d1 migrations apply`');
}
