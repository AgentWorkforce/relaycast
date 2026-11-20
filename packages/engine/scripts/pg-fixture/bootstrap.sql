-- Dev-only PostgreSQL test fixture for packages/engine (see up.sh).
-- The passwords below are fixed dev fixture values, not secrets; they match
-- the defaults in src/adapters/postgres/__tests__/postgres.integration.test.ts.
-- Never use this bootstrap for a real deployment.
--
-- Runs once from /docker-entrypoint-initdb.d on a fresh container (database
-- "app"). Statements are guarded so a re-run on the same cluster is harmless.

-- Owner and runtime roles, and schema public handed to the owner, as
-- docs/self-host-postgres.md ("What the platform provides") describes.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'relaycast_owner') THEN
    CREATE ROLE relaycast_owner LOGIN PASSWORD 'owner-fixture-password';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'relaycast_runtime') THEN
    CREATE ROLE relaycast_runtime LOGIN PASSWORD 'runtime-fixture-password';
  END IF;
END
$$;
ALTER SCHEMA public OWNER TO relaycast_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO relaycast_runtime;

-- Runtime gets DML on everything the owner creates there, nothing more.
ALTER DEFAULT PRIVILEGES FOR ROLE relaycast_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO relaycast_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE relaycast_owner IN SCHEMA public
  GRANT SELECT, USAGE, UPDATE ON SEQUENCES TO relaycast_runtime;

-- Lock down the database: only the owner may create temporary objects.
REVOKE TEMP, CREATE ON DATABASE app FROM PUBLIC;
GRANT TEMP ON DATABASE app TO relaycast_owner;

-- Neighbour schemas the runtime must be denied on.
CREATE SCHEMA IF NOT EXISTS control;
CREATE TABLE IF NOT EXISTS control.tenants (id text PRIMARY KEY, secret text);
INSERT INTO control.tenants VALUES ('t1', 'control-secret') ON CONFLICT (id) DO NOTHING;
CREATE SCHEMA IF NOT EXISTS pipeline;
CREATE TABLE IF NOT EXISTS pipeline.runs (id text PRIMARY KEY);
REVOKE ALL ON SCHEMA control, pipeline FROM PUBLIC;
REVOKE ALL ON SCHEMA control, pipeline FROM relaycast_owner, relaycast_runtime;

-- Wrong-binding roles for the refusal tests.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'relaycast_admin') THEN
    CREATE ROLE relaycast_admin LOGIN PASSWORD 'admin-dev-password' SUPERUSER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'relaycast_runtime_member') THEN
    CREATE ROLE relaycast_runtime_member LOGIN PASSWORD 'member-dev-password' IN ROLE relaycast_owner;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'relaycast_creator') THEN
    CREATE ROLE relaycast_creator LOGIN PASSWORD 'creator-dev-password';
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO relaycast_creator;
