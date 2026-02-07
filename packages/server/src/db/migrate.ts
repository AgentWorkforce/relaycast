import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getDb } from './index.js';

/**
 * Run database migrations on application start.
 * Uses Drizzle's migrator to apply SQL migration files in order.
 * Only unapplied migrations will run.
 */
export async function runMigrations(): Promise<void> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  // In dist: packages/server/dist/db/migrate.js -> need packages/server/src/db/migrations
  // In dev:  packages/server/src/db/migrate.ts  -> need packages/server/src/db/migrations
  const migrationsFolder = join(__dirname, '..', '..', 'src', 'db', 'migrations');

  const db = getDb();
  await migrate(db, { migrationsFolder });
  console.log('Database migrations complete');
}
