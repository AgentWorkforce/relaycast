import { describe, expect, it } from 'vitest';
import {
  NODE_DELIVER_FRAME_EVENT_TYPES,
  NodeFrameKindSchema,
  isNodeDeliverFrameEventType,
  nodeFrameKindFor,
} from '../index.js';

describe('node frame kind', () => {
  it('declares exactly the four deliver-frame event types', () => {
    expect([...NODE_DELIVER_FRAME_EVENT_TYPES]).toEqual([
      'message.created',
      'thread.reply',
      'message.read',
      'message.reacted',
    ]);
  });

  it('routes every declared type to the deliver frame', () => {
    for (const type of NODE_DELIVER_FRAME_EVENT_TYPES) {
      expect(isNodeDeliverFrameEventType(type)).toBe(true);
      expect(nodeFrameKindFor(type)).toBe('deliver');
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
  ])('routes %s to the context frame', (type) => {
    expect(isNodeDeliverFrameEventType(type)).toBe(false);
    expect(nodeFrameKindFor(type)).toBe('context');
  });

  it('only produces values in the frame kind enum', () => {
    expect(NodeFrameKindSchema.parse(nodeFrameKindFor('message.created'))).toBe('deliver');
    expect(NodeFrameKindSchema.parse(nodeFrameKindFor('member.left'))).toBe('context');
  });
});
