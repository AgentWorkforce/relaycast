import { describe, expect, it } from 'vitest';
import { postgresServeRefusal } from '../postgresServeGuard.js';

describe('postgresServeRefusal', () => {
  it('allows the SQLite server when no PostgreSQL variable is set', () => {
    expect(postgresServeRefusal({})).toBeUndefined();
    expect(postgresServeRefusal({ RELAYCAST_DB_PATH: '/data/relaycast.db', RELAYCAST_PORT: '7528' })).toBeUndefined();
    // Blank values count as unset, like every other RELAYCAST_* secret.
    expect(postgresServeRefusal({ RELAYCAST_DATABASE_URL: '', RELAYCAST_DATABASE_CA_FILE: '  ' })).toBeUndefined();
  });

  it.each([
    'RELAYCAST_DATABASE_URL',
    'RELAYCAST_DATABASE_URL_FILE',
    'RELAYCAST_DATABASE_CA_FILE',
    'RELAYCAST_DATABASE_SCHEMA',
    'RELAYCAST_DATABASE_OWNER_ROLE',
    'RELAYCAST_DATABASE_RUNTIME_ROLE',
    'RELAYCAST_DATABASE_POOL_MAX',
    'RELAYCAST_DATABASE_STATEMENT_TIMEOUT_MS',
  ])('refuses when %s is set', (name) => {
    expect(postgresServeRefusal({ [name]: 'x' })).toMatch(
      new RegExp(`^the PostgreSQL serving path is not available in this build \\(${name} set\\)`),
    );
  });

  it('names every variable, never a value, and points at the subcommands', () => {
    const secret = 'pw-dev-only-789';
    const message = postgresServeRefusal({
      RELAYCAST_DATABASE_URL: `postgres://u:${secret}@db.example.test/app`,
      RELAYCAST_DATABASE_CA_FILE: '/etc/ca.pem',
    });
    expect(message).toContain('(RELAYCAST_DATABASE_CA_FILE, RELAYCAST_DATABASE_URL set)');
    expect(message).toMatch(/migrate.*verify-db/);
    expect(message).not.toContain(secret);
    expect(message).not.toContain('/etc/ca.pem');
  });
});
