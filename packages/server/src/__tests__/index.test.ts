import { describe, it, expect } from 'vitest';
import { SERVER_VERSION } from '../index.js';

describe('@relaycast/server', () => {
  it('exports SERVER_VERSION', () => {
    expect(SERVER_VERSION).toBe('0.1.0');
  });
});

