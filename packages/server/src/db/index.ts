import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

let sql: ReturnType<typeof postgres> | null = null;
let db: ReturnType<typeof drizzle> | null = null;

export interface DbConfig {
  url?: string;
  max?: number; // max pool connections, default 25
  idleTimeout?: number; // seconds, default 20
  connectTimeout?: number; // seconds, default 10
  maxLifetime?: number; // max connection lifetime in seconds
}

export function getDb(config?: DbConfig) {
  if (!db) {
    const url =
      config?.url ||
      process.env.DATABASE_URL ||
      'postgresql://relay:relay@localhost:5433/relay';

    sql = postgres(url, {
      max: config?.max || 25,
      idle_timeout: config?.idleTimeout || 20,
      connect_timeout: config?.connectTimeout || 10,
      max_lifetime: config?.maxLifetime || 60 * 30, // 30 min
    });

    db = drizzle(sql, { schema });
  }
  return db;
}

export function getSql() {
  if (!sql) {
    throw new Error('Database not initialized. Call getDb() first.');
  }
  return sql;
}

export async function closeDb(): Promise<void> {
  if (sql) {
    await sql.end();
    sql = null;
    db = null;
  }
}

export async function healthCheck(): Promise<boolean> {
  try {
    const s = getSql();
    await s`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

