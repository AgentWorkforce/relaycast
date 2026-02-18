import { describe, it, expect } from 'vitest';
import { getDb, healthCheck } from '../index.js';

function createMockD1(shouldThrow = false): D1Database {
  return {
    prepare: () => ({
      first: async () => {
        if (shouldThrow) throw new Error('query failed');
        return { ok: 1 } as unknown;
      },
    }),
  } as unknown as D1Database;
}

describe('Database Connection', () => {
  it('getDb returns a drizzle instance', () => {
    const db = getDb(createMockD1());
    expect(db).toBeDefined();
    expect(typeof db.select).toBe('function');
  });

  it('getDb creates a new instance per call', () => {
    const binding = createMockD1();
    const db1 = getDb(binding);
    const db2 = getDb(binding);
    // Per-request instances — not singleton
    expect(db1).toBeDefined();
    expect(db2).toBeDefined();
    expect(db1).not.toBe(db2);
  });

  it('getDb works with different D1 bindings', () => {
    const db = getDb(createMockD1());
    expect(db).toBeDefined();
    expect(typeof db.select).toBe('function');
  });

  it('healthCheck returns false when query fails', async () => {
    const result = await healthCheck(createMockD1(true));
    expect(result).toBe(false);
  });
});
