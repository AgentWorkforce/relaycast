import { describe, it, expect, beforeEach } from 'vitest';
import { SnowflakeGenerator, generateId } from '../snowflake.js';

describe('SnowflakeGenerator', () => {
  let generator: SnowflakeGenerator;

  beforeEach(() => {
    generator = new SnowflakeGenerator(1);
  });

  it('generates string IDs', () => {
    const id = generator.generate();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('generates 10,000 unique IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10000; i++) {
      ids.add(generator.generate());
    }
    expect(ids.size).toBe(10000);
  });

  it('generates 10,000 IDs in under 100ms', () => {
    const start = Date.now();
    for (let i = 0; i < 10000; i++) {
      generator.generate();
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
  });

  it('generates monotonically increasing IDs', () => {
    const ids: bigint[] = [];
    for (let i = 0; i < 1000; i++) {
      ids.push(BigInt(generator.generate()));
    }
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    }
  });

  it('extracts timestamp correctly (roundtrip)', () => {
    const before = Date.now();
    const id = generator.generate();
    const after = Date.now();
    const extracted = SnowflakeGenerator.extractTimestamp(id);
    expect(extracted).toBeGreaterThanOrEqual(before);
    expect(extracted).toBeLessThanOrEqual(after);
  });

  it('extracts worker ID correctly', () => {
    const gen = new SnowflakeGenerator(42);
    const id = gen.generate();
    expect(SnowflakeGenerator.extractWorkerId(id)).toBe(42);
  });

  it('extracts sequence correctly', () => {
    // First ID in a millisecond should have sequence 0
    const gen = new SnowflakeGenerator(1);
    const id = gen.generate();
    expect(SnowflakeGenerator.extractSequence(id)).toBe(0);
  });

  it('derives worker ID from FLY_MACHINE_ID env', () => {
    const original = process.env.FLY_MACHINE_ID;
    process.env.FLY_MACHINE_ID = 'test-machine-123';
    const gen = new SnowflakeGenerator();
    const workerId = gen.getWorkerId();
    expect(workerId).toBeGreaterThanOrEqual(0);
    expect(workerId).toBeLessThanOrEqual(1023);
    // Same machine ID should produce same worker ID
    const gen2 = new SnowflakeGenerator();
    expect(gen2.getWorkerId()).toBe(workerId);
    process.env.FLY_MACHINE_ID = original;
  });

  it('worker ID wraps to 10 bits (0-1023)', () => {
    const gen = new SnowflakeGenerator(1024);
    expect(gen.getWorkerId()).toBeLessThanOrEqual(1023);
  });

  it('generateId convenience function works', () => {
    const id = generateId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });
});

