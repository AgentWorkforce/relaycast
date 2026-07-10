import { drizzle } from 'drizzle-orm/d1';
// Single source of truth: use the engine's schema rather than a local copy, so
// the DO queries and the engine's own queries share one definition.
import { schema } from '@relaycast/engine';

type D1Db = ReturnType<typeof drizzle>;

/**
 * Create a per-request database instance using the D1 driver.
 * On Cloudflare Workers, pass `c.env.DB` (the D1 binding).
 */
export function getDb(d1: D1Database): D1Db {
  return drizzle(d1, { schema });
}

/**
 * Health check — run a simple query to verify DB connectivity.
 */
export async function healthCheck(d1: D1Database): Promise<boolean> {
  try {
    await d1.prepare('SELECT 1').first();
    return true;
  } catch {
    return false;
  }
}
