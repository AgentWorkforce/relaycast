import { describe, it, expect, beforeEach } from 'vitest';
import { SubscriptionManager } from '../resources/subscriptions.js';

describe('SubscriptionManager', () => {
  let manager: SubscriptionManager;

  beforeEach(() => {
    manager = new SubscriptionManager();
  });

  it('starts with no subscriptions', () => {
    expect(manager.getAll()).toEqual([]);
  });

  it('subscribe adds a URI', () => {
    manager.subscribe('relay://inbox');
    expect(manager.isSubscribed('relay://inbox')).toBe(true);
  });

  it('unsubscribe removes a URI', () => {
    manager.subscribe('relay://inbox');
    manager.unsubscribe('relay://inbox');
    expect(manager.isSubscribed('relay://inbox')).toBe(false);
  });

  it('duplicate subscribe is idempotent', () => {
    manager.subscribe('relay://inbox');
    manager.subscribe('relay://inbox');
    expect(manager.getAll()).toEqual(['relay://inbox']);
  });

  it('getMatchingSubscriptions returns only subscribed URIs', () => {
    manager.subscribe('relay://inbox');
    manager.subscribe('relay://agents');
    const matched = manager.getMatchingSubscriptions([
      'relay://inbox',
      'relay://channels/general/messages',
      'relay://agents',
    ]);
    expect(matched).toEqual(['relay://inbox', 'relay://agents']);
  });

  it('getMatchingSubscriptions returns empty when no matches', () => {
    manager.subscribe('relay://inbox');
    const matched = manager.getMatchingSubscriptions(['relay://agents']);
    expect(matched).toEqual([]);
  });

  it('clear removes all subscriptions', () => {
    manager.subscribe('relay://inbox');
    manager.subscribe('relay://agents');
    manager.clear();
    expect(manager.getAll()).toEqual([]);
  });
});
