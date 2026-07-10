import { applyD1Migrations, env } from 'cloudflare:test';

// Runs once per worker before the suite: applies the engine's D1 schema
// (src/db/migrations) to the test database. applyD1Migrations is idempotent —
// it tracks applied migrations in a d1_migrations table.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
