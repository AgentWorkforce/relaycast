import { describe, expect, it } from 'vitest';
import {
  ORIGIN_ACTOR_HEADER,
  UNKNOWN_ORIGIN_ACTOR,
  extractOriginActor,
} from '../origin.js';

function headers(init: Record<string, string>): Headers {
  return new Headers(init);
}

describe('extractOriginActor', () => {
  it('returns unknown when the header is missing', () => {
    expect(extractOriginActor(headers({}))).toBe(UNKNOWN_ORIGIN_ACTOR);
  });

  it('returns unknown when the header is empty or whitespace', () => {
    expect(extractOriginActor(headers({ [ORIGIN_ACTOR_HEADER]: '' }))).toBe(UNKNOWN_ORIGIN_ACTOR);
    expect(extractOriginActor(headers({ [ORIGIN_ACTOR_HEADER]: '   ' }))).toBe(UNKNOWN_ORIGIN_ACTOR);
  });

  it('lowercases well-formed values', () => {
    expect(extractOriginActor(headers({ [ORIGIN_ACTOR_HEADER]: 'Claude-Code' }))).toBe('claude-code');
    expect(extractOriginActor(headers({ [ORIGIN_ACTOR_HEADER]: 'CURSOR' }))).toBe('cursor');
  });

  it('accepts the {app}/{type}/{name} path with version + model', () => {
    expect(
      extractOriginActor(headers({ [ORIGIN_ACTOR_HEADER]: 'Agent-Relay-Cli/agent/Claude-Code@2.3.1-Opus4.8' })),
    ).toBe('agent-relay-cli/agent/claude-code@2.3.1-opus4.8');
    expect(extractOriginActor(headers({ [ORIGIN_ACTOR_HEADER]: 'agent-relay-cli/cli' }))).toBe(
      'agent-relay-cli/cli',
    );
    expect(extractOriginActor(headers({ [ORIGIN_ACTOR_HEADER]: 'pear/user/send-message-box' }))).toBe(
      'pear/user/send-message-box',
    );
  });

  it('accepts unknown identifiers (we segment server-side later)', () => {
    expect(extractOriginActor(headers({ [ORIGIN_ACTOR_HEADER]: 'my-new-app/agent/foobar' }))).toBe(
      'my-new-app/agent/foobar',
    );
  });

  it('rejects oversized values (>128)', () => {
    const long = 'a'.repeat(200);
    expect(extractOriginActor(headers({ [ORIGIN_ACTOR_HEADER]: long }))).toBe(UNKNOWN_ORIGIN_ACTOR);
  });

  it('rejects disallowed characters (whitespace, semicolons, etc.) but allows / and @', () => {
    expect(extractOriginActor(headers({ [ORIGIN_ACTOR_HEADER]: 'claude code' }))).toBe(UNKNOWN_ORIGIN_ACTOR);
    expect(extractOriginActor(headers({ [ORIGIN_ACTOR_HEADER]: 'a/b;c' }))).toBe(UNKNOWN_ORIGIN_ACTOR);
    // `/` and `@` are part of the path/version syntax and must be accepted:
    expect(extractOriginActor(headers({ [ORIGIN_ACTOR_HEADER]: 'a/b/c@1.0' }))).toBe('a/b/c@1.0');
  });
});
