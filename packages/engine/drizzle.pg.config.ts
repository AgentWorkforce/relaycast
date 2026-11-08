import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit config for the PostgreSQL migrations only. Run through
 * `npm run generate:pg-migrations` (scripts/generate-pg-migrations.mjs), which
 * refuses role/schema DDL: the platform pre-creates the database and roles and
 * hands schema `public` to the owner role.
 * No database connection is needed to generate.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.pg.ts',
  out: './src/db/migrations-pg',
  schemaFilter: ['public'],
  strict: true,
  verbose: true,
});
