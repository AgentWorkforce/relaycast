import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import * as schema from "../../lib/db/schema";

type MigrationJournal = {
  entries: Array<{
    tag: string;
  }>;
};

const helpersDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(helpersDir, "../..");
const drizzleRoot = path.join(webRoot, "drizzle");
const journalPath = path.join(drizzleRoot, "meta/_journal.json");

function normalizeMigrationSql(sql: string): string {
  return sql
    .replace(/^-->\s*statement-breakpoint\s*$/gmu, "")
    .replace(/^CREATE EXTENSION IF NOT EXISTS .*;$/gmu, "")
    .trim();
}

async function loadMigrationSql(): Promise<string[]> {
  const journal = JSON.parse(
    await fs.readFile(journalPath, "utf8"),
  ) as MigrationJournal;

  const migrations: string[] = [];

  for (const entry of journal.entries) {
    const migrationPath = path.join(drizzleRoot, `${entry.tag}.sql`);
    const sql = normalizeMigrationSql(await fs.readFile(migrationPath, "utf8"));
    if (sql.length > 0) {
      migrations.push(`-- ${entry.tag}\n${sql}`);
    }
  }

  return migrations;
}

export async function createPgliteDb() {
  const client = new PGlite();

  for (const migrationSql of await loadMigrationSql()) {
    await client.exec(migrationSql);
  }

  const db = drizzle(client, { schema });

  return {
    client,
    db,
    schema,
    exec: (sql: string) => client.exec(sql),
    cleanup: () => client.close(),
  };
}
