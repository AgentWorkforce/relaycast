import { describe, it, expect, beforeEach } from 'vitest';
import { SubscriptionManager } from '../resources/subscriptions.js';
import { eventToResourceUris } from '../resources/ws-bridge.js';
import type { ServerEvent } from '@relaycast/types';

describe('Resource subscription integration', () => {
  let manager: SubscriptionManager;
  let notified: string[];

  beforeEach(() => {
    manager = new SubscriptionManager();
    notified = [];
  });

  function simulateEvent(event: ServerEvent) {
    const uris = eventToResourceUris(event);
    const matched = manager.getMatchingSubscriptions(uris);
    for (const uri of matched) {
      notified.push(uri);
    }
  }

  it('notifies subscribed inbox on message.created', () => {
    manager.subscribe('relay://inbox');
    simulateEvent({
      type: 'message.created',
      channel: 'general',
      message: { id: 'm1', agent_name: 'bot', text: 'hi', attachments: [] },
    } as ServerEvent);
    expect(notified).toEqual(['relay://inbox']);
  });

  it('notifies subscribed channel on message.created', () => {
    manager.subscribe('relay://channels/general/messages');
    simulateEvent({
      type: 'message.created',
      channel: 'general',
      message: { id: 'm1', agent_name: 'bot', text: 'hi', attachments: [] },
    } as ServerEvent);
    expect(notified).toEqual(['relay://channels/general/messages']);
  });

  it('notifies both inbox and channel when both subscribed', () => {
    manager.subscribe('relay://inbox');
    manager.subscribe('relay://channels/general/messages');
    simulateEvent({
      type: 'message.created',
      channel: 'general',
      message: { id: 'm1', agent_name: 'bot', text: 'hi', attachments: [] },
    } as ServerEvent);
    expect(notified).toEqual([
      'relay://inbox',
      'relay://channels/general/messages',
    ]);
  });

  it('does not notify unsubscribed resources', () => {
    manager.subscribe('relay://channels/random/messages');
    simulateEvent({
      type: 'message.created',
      channel: 'general',
      message: { id: 'm1', agent_name: 'bot', text: 'hi', attachments: [] },
    } as ServerEvent);
    expect(notified).toEqual([]);
  });

  it('stops notifying after unsubscribe', () => {
    manager.subscribe('relay://inbox');
    manager.unsubscribe('relay://inbox');
    simulateEvent({
      type: 'message.created',
      channel: 'general',
      message: { id: 'm1', agent_name: 'bot', text: 'hi', attachments: [] },
    } as ServerEvent);
    expect(notified).toEqual([]);
  });

  it('handles dm.received with subscription', () => {
    manager.subscribe('relay://dm/conv1');
    simulateEvent({
      type: 'dm.received',
      conversation_id: 'conv1',
      message: { id: 'd1', agent_name: 'bot', text: 'hey' },
    } as ServerEvent);
    expect(notified).toEqual(['relay://dm/conv1']);
  });

  it('handles thread.reply with thread subscription', () => {
    manager.subscribe('relay://messages/p1/thread');
    simulateEvent({
      type: 'thread.reply',
      parent_id: 'p1',
      message: { id: 'r1', agent_name: 'bot', text: 'reply' },
    } as ServerEvent);
    expect(notified).toEqual(['relay://messages/p1/thread']);
  });

  it('handles agent presence changes', () => {
    manager.subscribe('relay://agents');
    simulateEvent({
      type: 'agent.online',
      agent: { name: 'bot1' },
    } as ServerEvent);
    simulateEvent({
      type: 'agent.offline',
      agent: { name: 'bot1' },
    } as ServerEvent);
    expect(notified).toEqual(['relay://agents', 'relay://agents']);
  });
});
