import { describe, it, expect, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerSystemPrompt, DEFAULT_SYSTEM_PROMPT } from '../prompts.js';

describe('system prompt', () => {
  let client: Client;

  beforeEach(async () => {
    const mcpServer = new McpServer(
      { name: 'test', version: '0.1.0' },
      { capabilities: { prompts: {} } },
    );
    registerSystemPrompt(mcpServer);
    client = new Client({ name: 'test-client', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), mcpServer.connect(st)]);
  });

  it('lists system_prompt', async () => {
    const prompts = await client.listPrompts();
    expect(prompts.prompts.length).toBe(1);
    expect(prompts.prompts[0].name).toBe('system_prompt');
  });

  it('returns prompt content', async () => {
    const result = await client.getPrompt({ name: 'system_prompt' });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content).toEqual({
      type: 'text',
      text: DEFAULT_SYSTEM_PROMPT,
    });
  });

  it('DEFAULT_SYSTEM_PROMPT is a non-empty string', () => {
    expect(typeof DEFAULT_SYSTEM_PROMPT).toBe('string');
    expect(DEFAULT_SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });
});

