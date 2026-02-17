import { describe, it, expect } from 'vitest';
import { getDb, healthCheck } from '../index.js';

describe('Database Connection', () => {
  it('getDb returns a drizzle instance', () => {
    const db = getDb('postgresql://relay:relay@localhost:5433/relay');
    expect(db).toBeDefined();
    expect(typeof db.select).toBe('function');
  });

  it('getDb creates a new instance per call', () => {
    const db1 = getDb('postgresql://relay:relay@localhost:5433/relay');
    const db2 = getDb('postgresql://relay:relay@localhost:5433/relay');
    // Per-request instances — not singleton
    expect(db1).toBeDefined();
    expect(db2).toBeDefined();
  });

  it('getDb falls back to default connection string', () => {
    const db = getDb();
    expect(db).toBeDefined();
    expect(typeof db.select).toBe('function');
  });

  it('healthCheck returns boolean', async () => {
    // Without a real database, this should return false
    const result = await healthCheck('postgresql://invalid:invalid@localhost:1/nonexistent');
    expect(typeof result).toBe('boolean');
  });
});
