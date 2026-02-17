import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import * as schema from './schema.js';

type NeonDb = ReturnType<typeof drizzle>;

/**
 * Create a per-request database instance using the Neon HTTP driver.
 * On Cloudflare Workers, pass `c.env.HYPERDRIVE.connectionString`.
 * For local dev / tests, falls back to DATABASE_URL env var.
 */
export function getDb(connectionString?: string): NeonDb {
  const url =
    connectionString ||
    (typeof process !== 'undefined' ? process.env?.DATABASE_URL : undefined) ||
    'postgresql://relay:relay@localhost:5433/relay';

  const sql = neon(url);
  return drizzle(sql, { schema });
}

/**
 * Health check — run a simple query to verify DB connectivity.
 */
export async function healthCheck(connectionString?: string): Promise<boolean> {
  try {
    const sql = neon(
      connectionString ||
      (typeof process !== 'undefined' ? process.env?.DATABASE_URL : undefined) ||
      'postgresql://relay:relay@localhost:5433/relay',
    );
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
