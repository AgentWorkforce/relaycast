import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit config for the PostgreSQL migrations only. Run through
 * `npm run generate:pg-migrations` (scripts/generate-pg-migrations.mjs), which
 * strips the `CREATE SCHEMA` drizzle-kit emits for pgSchema('relaycast') and
 * refuses role/schema DDL: the platform pre-creates the schema and roles.
 * No database connection is needed to generate.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.pg.ts',
  out: './src/db/migrations-pg',
  schemaFilter: ['relaycast'],
  strict: true,
  verbose: true,
});
