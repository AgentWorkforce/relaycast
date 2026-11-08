import { describe, expect, it } from 'vitest';
import { postgresServeRequested } from '../postgresServeGuard.js';

describe('postgresServeRequested', () => {
  it('selects PostgreSQL only when a RELAYCAST_DATABASE_* variable is non-blank', () => {
    expect(postgresServeRequested({})).toBe(false);
    expect(postgresServeRequested({ RELAYCAST_DB_PATH: '/data/relaycast.db' })).toBe(false);
    expect(postgresServeRequested({ RELAYCAST_DATABASE_URL: '  ' })).toBe(false);
    expect(postgresServeRequested({ RELAYCAST_DATABASE_URL: 'postgres://x' })).toBe(true);
    expect(postgresServeRequested({ RELAYCAST_DATABASE_URL_FILE: '/run/secrets/url' })).toBe(true);
    expect(postgresServeRequested({ RELAYCAST_DATABASE_SCHEMA: 'public' })).toBe(true);
  });
});
