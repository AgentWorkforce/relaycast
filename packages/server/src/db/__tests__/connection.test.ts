import { describe, it, expect, afterEach } from 'vitest';
import { getDb, closeDb, healthCheck } from '../index.js';

describe('Database Connection', () => {
  afterEach(async () => {
    await closeDb();
  });

  it('getDb returns a drizzle instance', () => {
    const db = getDb();
    expect(db).toBeDefined();
    expect(typeof db.select).toBe('function');
  });

  it('getDb returns same instance on multiple calls', () => {
    const db1 = getDb();
    const db2 = getDb();
    expect(db1).toBe(db2);
  });

  it('closeDb resets the instance', async () => {
    getDb();
    await closeDb();
    const db2 = getDb();
    expect(db2).toBeDefined();
  });

  it('healthCheck returns boolean', async () => {
    // Without a real database, this should return false
    getDb({ url: 'postgresql://invalid:invalid@localhost:1/nonexistent' });
    const result = await healthCheck();
    expect(typeof result).toBe('boolean');
  });
});

