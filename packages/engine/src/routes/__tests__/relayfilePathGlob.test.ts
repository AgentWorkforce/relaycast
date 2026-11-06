import { describe, expect, it } from 'vitest';
import { eventMatchesRelayfileGlob } from '../relayfilePathGlob.js';

// Agreement cases for relayfile-cloud ba817966 webhook-delivery.ts and its
// locked @relayfile/core 0.10.34 normalizePath contract.
describe('RelayFile webhook path-glob agreement', () => {
  it.each([
    ['/linear/issues/AR-705__uuid.json', '/linear/issues/*__uuid.json', true],
    ['/linear/issues/AR-705__other.json', '/linear/issues/*__uuid.json', false],
    ['/linear/issues/nested/AR-705__uuid.json', '/linear/issues/*__uuid.json', false],
    ['/jira/issues/KAN-1/comments/9.json', '/jira/issues/*/comments/*.json', true],
    ['/jira/issues/KAN-1/comments/deeper/9.json', '/jira/issues/*/comments/*.json', false],
    ['/jira/issues/KAN-1/comments/9.json', '/jira/issues/KAN*', true],
    ['/jira/issues/KAN-1/comments/9.json', '/jira/issues/*', false],
    ['/jira/issues/KAN-1', '/jira/issues/**', true],
    ['/jira/issues/KAN-1/comments/9.json', '/jira/**/comments/*.json', true],
    ['/jira/comments/9.json', '/jira/**/comments/*.json', true],
    ['/jira/a/b/comments/9.json', '/jira/**/**/comments/*.json', true],
    ['/jira/a/b/issues/9.json', '/jira/**/**/comments/*.json', false],
    [' jira//issues/./old/../KAN-1/comments/9.json/ ', ' /jira/issues/*/comments/*.json/ ', true],
    ['/jira/issues/KAN-1/comments/9.json', '/jira/issues/unused/../*/comments/*.json', true],
    ['/jira/issues/KAN-1/comments/9.json', '/Jira/issues/*/comments/*.json', false],
    ['/jira/issues/KAN-1/comments/9.json', '/jira/issues/*/comments/?.json', false],
    ['/jira/issues/KAN-1/comments/%39.json', '/jira/issues/*/comments/9.json', false],
    ['/', '/**', true],
    ['/anything/nested', '*', true],
    ['/jira/issues/KAN-1', '/jira/issues/KAN-1', true],
    ['/jira/issues/KAN-1/child', '/jira/issues/KAN-1', false],
  ])('%s against %s is %s', (path, glob, expected) => {
    expect(eventMatchesRelayfileGlob(path, glob)).toBe(expected);
  });
});

// Preserve Relaycast's pre-existing root-prefix behavior. Upstream currently
// canonicalizes the empty prefix to '/', which incorrectly requires '//'.
describe('Relaycast legacy root wildcard compatibility', () => {
  it.each([
    ['/issue.json', true],
    ['/', true],
    ['/nested/issue.json', false],
  ])('matches %s against /* as %s', (path, expected) => {
    expect(eventMatchesRelayfileGlob(path, '/*')).toBe(expected);
  });
});
