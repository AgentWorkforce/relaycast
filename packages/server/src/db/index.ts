import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

let sql: ReturnType<typeof postgres> | null = null;
let db: ReturnType<typeof drizzle> | null = null;

export interface DbConfig {
  url?: string;
  max?: number; // max pool connections, default 10
  idleTimeout?: number; // seconds, default 20
}

export function getDb(config?: DbConfig) {
  if (!db) {
    const url =
      config?.url ||
      process.env.DATABASE_URL ||
      'postgresql://relay:relay@localhost:5432/relay';

    sql = postgres(url, {
      max: config?.max || 10,
      idle_timeout: config?.idleTimeout || 20,
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

