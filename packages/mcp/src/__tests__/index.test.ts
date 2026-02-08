import { describe, it, expect } from 'vitest';
import { MCP_VERSION } from '../index.js';

describe('@relaycast/mcp', () => {
  it('exports MCP_VERSION', () => {
    expect(MCP_VERSION).toBe('0.1.0');
  });
});

