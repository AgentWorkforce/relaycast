/**
 * PostgreSQL connection, identity, TLS and migration layer, and the verified
 * engine handle (engineDb.ts). The server still serves SQLite only; the
 * handle is used by the conformance harness's PostgreSQL mode.
 */
export {
  DEFAULT_OWNER_ROLE,
  DEFAULT_RUNTIME_ROLE,
  DEFAULT_SCHEMA,
  describePostgresConfig,
  loadPostgresConfig,
  parseDatabaseUrl,
  readCaFile,
  type PostgresConfig,
  type PostgresMode,
} from "./config.js";
export {
  closePostgresPool,
  openPostgresPool,
  parseInt8,
  postgresPoolOptions,
  postgresTlsOptions,
} from "./pool.js";
export {
  verifyIdentity,
  type IdentityCheck,
  type IdentityResult,
  type Queryable,
  type VerifyIdentityOptions,
} from "./identity.js";
export {
  LEDGER_TABLE,
  bundleMigrations,
  loadBundledPostgresMigrations,
  postgresMigrationsDir,
  runPostgresMigrations,
  splitPostgresStatements,
  verifyPostgresMigrations,
  type AppliedMigration,
  type BundledMigration,
  type ClientSource,
  type RunMigrationsOptions,
  type RunMigrationsResult,
  type VerifyMigrationsOptions,
  type VerifyMigrationsResult,
} from "./migrate.js";
export {
  EXIT_CONFIG,
  EXIT_FAILURE,
  EXIT_IDENTITY,
  runMigrateCommand,
  runVerifyDbCommand,
} from "./cli.js";
export {
  brandPgEngineDb,
  buildPostgresEngineDb,
  openPostgresEngineDb,
  PostgresIdentityError,
  PostgresMigrationStateError,
  PostgresUnavailableError,
  type OpenPostgresEngineDbOptions,
  type PgBranded,
  type PgDrizzleDb,
  type PostgresEngineDb,
  type PostgresEngineHandle,
} from "./engineDb.js";
