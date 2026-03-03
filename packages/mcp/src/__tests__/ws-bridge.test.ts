import { describe, it, expect } from 'vitest';
import { eventToResourceUris } from '../resources/ws-bridge.js';
import type { WsClientEvent } from '@relaycast/sdk';

describe('eventToResourceUris', () => {
  it('maps message.created to inbox and channel', () => {
    const event = {
      type: 'message.created',
      channel: 'general',
      message: { id: 'm1', agentName: 'bot', text: 'hi', attachments: [] },
    } as WsClientEvent;
    expect(eventToResourceUris(event)).toEqual([
      'relay://inbox',
      'relay://channels/general/messages',
    ]);
  });

  it('maps message.updated to channel only', () => {
    const event = {
      type: 'message.updated',
      channel: 'general',
      message: { id: 'm1', agentName: 'bot', text: 'updated' },
    } as WsClientEvent;
    expect(eventToResourceUris(event)).toEqual([
      'relay://channels/general/messages',
    ]);
  });

  it('maps thread.reply to inbox and thread', () => {
    const event = {
      type: 'thread.reply',
      parentId: 'p1',
      message: { id: 'r1', agentName: 'bot', text: 'reply' },
    } as WsClientEvent;
    expect(eventToResourceUris(event)).toEqual([
      'relay://inbox',
      'relay://messages/p1/thread',
    ]);
  });

  it('maps dm.received to inbox and dm conversation', () => {
    const event = {
      type: 'dm.received',
      conversationId: 'conv1',
      message: { id: 'd1', agentName: 'bot', text: 'hey' },
    } as WsClientEvent;
    expect(eventToResourceUris(event)).toEqual([
      'relay://inbox',
      'relay://dm/conv1',
    ]);
  });

  it('maps group_dm.received to inbox and dm conversation', () => {
    const event = {
      type: 'group_dm.received',
      conversationId: 'gconv1',
      message: { id: 'g1', agentName: 'bot', text: 'group' },
    } as WsClientEvent;
    expect(eventToResourceUris(event)).toEqual([
      'relay://inbox',
      'relay://dm/gconv1',
    ]);
  });

  it('maps agent.online to agents resource', () => {
    const event = {
      type: 'agent.online',
      agent: { name: 'bot1' },
    } as WsClientEvent;
    expect(eventToResourceUris(event)).toEqual(['relay://agents']);
  });

  it('maps agent.offline to agents resource', () => {
    const event = {
      type: 'agent.offline',
      agent: { name: 'bot1' },
    } as WsClientEvent;
    expect(eventToResourceUris(event)).toEqual(['relay://agents']);
  });

  it('maps channel.created to channels resource', () => {
    const event = {
      type: 'channel.created',
      channel: { name: 'new-ch', topic: null },
    } as WsClientEvent;
    expect(eventToResourceUris(event)).toEqual(['relay://channels']);
  });

  it('maps channel.archived to channels resource', () => {
    const event = {
      type: 'channel.archived',
      channel: { name: 'old-ch' },
    } as WsClientEvent;
    expect(eventToResourceUris(event)).toEqual(['relay://channels']);
  });

  it('maps channel.updated to channels resource', () => {
    const event = {
      type: 'channel.updated',
      channel: { name: 'general', topic: 'New topic' },
    } as WsClientEvent;
    expect(eventToResourceUris(event)).toEqual(['relay://channels']);
  });

  it('maps member.joined to channels resource', () => {
    const event = {
      type: 'member.joined',
      channel: 'general',
      agentName: 'bot1',
    } as WsClientEvent;
    expect(eventToResourceUris(event)).toEqual(['relay://channels']);
  });

  it('maps member.left to channels resource', () => {
    const event = {
      type: 'member.left',
      channel: 'general',
      agentName: 'bot1',
    } as WsClientEvent;
    expect(eventToResourceUris(event)).toEqual(['relay://channels']);
  });

  it('maps webhook.received to channel messages', () => {
    const event = {
      type: 'webhook.received',
      webhookId: 'wh_1',
      channel: 'alerts',
      message: { id: 'm1', text: 'deploy', source: null },
    } as WsClientEvent;
    expect(eventToResourceUris(event)).toEqual([
      'relay://channels/alerts/messages',
    ]);
  });

  it('maps command.invoked to channel messages', () => {
    const event = {
      type: 'command.invoked',
      command: '/deploy',
      channel: 'general',
      invokedBy: 'agent1',
      args: null,
    } as WsClientEvent;
    expect(eventToResourceUris(event)).toEqual([
      'relay://channels/general/messages',
    ]);
  });

  it('returns empty array for unknown event types', () => {
    const event = { type: 'pong' } as WsClientEvent;
    expect(eventToResourceUris(event)).toEqual([]);
  });

  it('maps reaction.added to inbox as a soft notification signal', () => {
    const event = {
      type: 'reaction.added',
      messageId: 'm1',
      emoji: 'thumbsup',
      agentName: 'bot',
    } as WsClientEvent;
    expect(eventToResourceUris(event)).toEqual(['relay://inbox']);
  });

  it('maps reaction.removed to inbox as a soft notification signal', () => {
    const event = {
      type: 'reaction.removed',
      messageId: 'm1',
      emoji: 'thumbsup',
      agentName: 'bot',
    } as WsClientEvent;
    expect(eventToResourceUris(event)).toEqual(['relay://inbox']);
  });
});
