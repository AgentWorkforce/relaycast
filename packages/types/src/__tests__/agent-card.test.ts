import { describe, expect, it } from 'vitest';
import {
  AgentCardMetadataSchema,
  AgentSkillsInputSchema,
  CreateAgentRequestSchema,
  UpdateAgentRequestSchema,
} from '../index.js';

const card = {
  description: 'Operates AWS infrastructure.',
  updated_at: '2026-11-13T09:00:00.000Z',
  version: '1',
};

describe('agent card schemas', () => {
  it('UpdateAgentRequestSchema accepts skills (with examples) and capabilities, like the server', () => {
    const parsed = UpdateAgentRequestSchema.parse({
      metadata: { card, source: 'hosted' },
      skills: [{ id: 'cost-report', name: 'Cost report', examples: ['What did EC2 cost?'] }],
      capabilities: null,
    });
    expect(parsed.skills?.[0]?.examples).toEqual(['What did EC2 cost?']);
    expect(parsed.capabilities).toBeNull();
    expect(parsed.metadata).toEqual({ card, source: 'hosted' });
  });

  it('bounds skills', () => {
    expect(AgentSkillsInputSchema.safeParse(Array.from({ length: 20 }, (_, i) => ({ name: `s${i}` }))).success).toBe(true);
    expect(AgentSkillsInputSchema.safeParse(Array.from({ length: 21 }, (_, i) => ({ name: `s${i}` }))).success).toBe(false);
    expect(AgentSkillsInputSchema.safeParse([{ name: 's', examples: Array(6).fill('x') }]).success).toBe(false);
    expect(AgentSkillsInputSchema.safeParse([{ name: 's', examples: ['x'.repeat(201)] }]).success).toBe(false);
    expect(AgentSkillsInputSchema.safeParse([{ id: 'a', name: 'one' }, { id: 'a', name: 'two' }]).success).toBe(false);
  });

  it('validates metadata.card on create and update', () => {
    expect(AgentCardMetadataSchema.safeParse({ ...card, documentation_url: 'https://docs.example' }).success).toBe(true);
    expect(AgentCardMetadataSchema.safeParse({ ...card, documentation_url: 'http://docs.example' }).success).toBe(false);
    expect(CreateAgentRequestSchema.safeParse({ name: 'a', metadata: { card: { description: 'x' } } }).success).toBe(false);
    expect(UpdateAgentRequestSchema.safeParse({ metadata: { card: { ...card, tags: Array(11).fill('t') } } }).success).toBe(false);
    expect(UpdateAgentRequestSchema.safeParse({ metadata: { other: 'kept' } }).success).toBe(true);
  });
});
