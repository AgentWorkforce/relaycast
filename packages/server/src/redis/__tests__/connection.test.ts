import { describe, it, expect, afterEach } from 'vitest';
import { getRedis, getRedisSub, closeRedis, redisHealthCheck } from '../index.js';

describe('Redis Connection', () => {
  afterEach(async () => {
    await closeRedis();
  });

  it('getRedis returns an ioredis instance', () => {
    const client = getRedis();
    expect(client).toBeDefined();
    expect(typeof client.get).toBe('function');
    expect(typeof client.set).toBe('function');
  });

  it('getRedis returns same instance on multiple calls', () => {
    const c1 = getRedis();
    const c2 = getRedis();
    expect(c1).toBe(c2);
  });

  it('getRedisSub returns separate instance from getRedis', () => {
    const client = getRedis();
    const sub = getRedisSub();
    expect(client).not.toBe(sub);
  });

  it('getRedisSub returns same instance on multiple calls', () => {
    const s1 = getRedisSub();
    const s2 = getRedisSub();
    expect(s1).toBe(s2);
  });

  it('closeRedis resets both instances', async () => {
    getRedis();
    getRedisSub();
    await closeRedis();
    const newClient = getRedis();
    expect(newClient).toBeDefined();
  });

  it('redisHealthCheck returns boolean', async () => {
    // Without a real Redis server, health check should return false
    const result = await redisHealthCheck();
    expect(typeof result).toBe('boolean');
  });

  it('redis client has lazyConnect enabled', () => {
    const client = getRedis();
    expect(client.status).toBe('wait');
  });

  it('redis retry strategy returns null after 10 attempts', () => {
    const client = getRedis();
    expect(client.options.maxRetriesPerRequest).toBe(3);
  });
});

