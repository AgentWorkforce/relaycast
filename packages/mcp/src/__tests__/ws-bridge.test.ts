import { describe, it, expect } from 'vitest';
import { eventToResourceUris } from '../resources/ws-bridge.js';
import type { ServerEvent } from '@agent-relay/types';

describe('eventToResourceUris', () => {
  it('maps message.created to inbox and channel', () => {
    const event = {
      type: 'message.created',
      channel: 'general',
      message: { id: 'm1', agent_name: 'bot', text: 'hi', attachments: [] },
    } as ServerEvent;
    expect(eventToResourceUris(event)).toEqual([
      'relay://inbox',
      'relay://channels/general/messages',
    ]);
  });

  it('maps message.updated to channel only', () => {
    const event = {
      type: 'message.updated',
      channel: 'general',
      message: { id: 'm1', agent_name: 'bot', text: 'updated' },
    } as ServerEvent;
    expect(eventToResourceUris(event)).toEqual([
      'relay://channels/general/messages',
    ]);
  });

  it('maps thread.reply to inbox and thread', () => {
    const event = {
      type: 'thread.reply',
      parent_id: 'p1',
      message: { id: 'r1', agent_name: 'bot', text: 'reply' },
    } as ServerEvent;
    expect(eventToResourceUris(event)).toEqual([
      'relay://inbox',
      'relay://messages/p1/thread',
    ]);
  });

  it('maps dm.received to inbox and dm conversation', () => {
    const event = {
      type: 'dm.received',
      conversation_id: 'conv1',
      message: { id: 'd1', agent_name: 'bot', text: 'hey' },
    } as ServerEvent;
    expect(eventToResourceUris(event)).toEqual([
      'relay://inbox',
      'relay://dm/conv1',
    ]);
  });

  it('maps group_dm.received to inbox and dm conversation', () => {
    const event = {
      type: 'group_dm.received',
      conversation_id: 'gconv1',
      message: { id: 'g1', agent_name: 'bot', text: 'group' },
    } as ServerEvent;
    expect(eventToResourceUris(event)).toEqual([
      'relay://inbox',
      'relay://dm/gconv1',
    ]);
  });

  it('maps agent.online to agents resource', () => {
    const event = {
      type: 'agent.online',
      agent: { name: 'bot1' },
    } as ServerEvent;
    expect(eventToResourceUris(event)).toEqual(['relay://agents']);
  });

  it('maps agent.offline to agents resource', () => {
    const event = {
      type: 'agent.offline',
      agent: { name: 'bot1' },
    } as ServerEvent;
    expect(eventToResourceUris(event)).toEqual(['relay://agents']);
  });

  it('maps channel.created to channels resource', () => {
    const event = {
      type: 'channel.created',
      channel: { name: 'new-ch', topic: null },
    } as ServerEvent;
    expect(eventToResourceUris(event)).toEqual(['relay://channels']);
  });

  it('maps channel.archived to channels resource', () => {
    const event = {
      type: 'channel.archived',
      channel: { name: 'old-ch' },
    } as ServerEvent;
    expect(eventToResourceUris(event)).toEqual(['relay://channels']);
  });

  it('returns empty array for unknown event types', () => {
    const event = { type: 'pong' } as ServerEvent;
    expect(eventToResourceUris(event)).toEqual([]);
  });

  it('returns empty array for reaction events', () => {
    const event = {
      type: 'reaction.added',
      message_id: 'm1',
      emoji: 'thumbsup',
      agent_name: 'bot',
    } as ServerEvent;
    expect(eventToResourceUris(event)).toEqual([]);
  });
});
