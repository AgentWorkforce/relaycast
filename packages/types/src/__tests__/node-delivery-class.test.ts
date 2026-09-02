import { describe, expect, it } from 'vitest';
import {
  NODE_DURABLE_EVENT_TYPES,
  NodeDeliveryClassSchema,
  isNodeDurableEventType,
  nodeDeliveryClassFor,
} from '../index.js';

describe('node delivery class', () => {
  it('declares exactly the four durable event types', () => {
    expect([...NODE_DURABLE_EVENT_TYPES]).toEqual([
      'message.created',
      'thread.reply',
      'message.read',
      'message.reacted',
    ]);
  });

  it('classifies every declared durable type as durable', () => {
    for (const type of NODE_DURABLE_EVENT_TYPES) {
      expect(isNodeDurableEventType(type)).toBe(true);
      expect(nodeDeliveryClassFor(type)).toBe('durable');
    }
  });

  it.each([
    'agent.status.changed',
    'member.joined',
    'delivery.failed',
    'message.updated',
    'channel.created',
    'not.a.real.event',
    '',
  ])('classifies %s as ephemeral', (type) => {
    expect(isNodeDurableEventType(type)).toBe(false);
    expect(nodeDeliveryClassFor(type)).toBe('ephemeral');
  });

  it('only produces values in the delivery class enum', () => {
    expect(NodeDeliveryClassSchema.parse(nodeDeliveryClassFor('message.created'))).toBe('durable');
    expect(NodeDeliveryClassSchema.parse(nodeDeliveryClassFor('member.left'))).toBe('ephemeral');
  });
});
