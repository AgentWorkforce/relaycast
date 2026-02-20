import { describe, expect, it } from 'vitest';
import { normalizeRoutePathForTelemetry } from '../serverTelemetry.js';

describe('normalizeRoutePathForTelemetry', () => {
  it('strips query/hash and normalizes repeated slashes', () => {
    expect(normalizeRoutePathForTelemetry('v1//channels///general/messages?limit=10#x')).toBe('/v1/channels/general/messages');
  });

  it('normalizes numeric and UUID-like dynamic segments', () => {
    expect(normalizeRoutePathForTelemetry('/v1/messages/1234567890123/reactions')).toBe('/v1/messages/:id/reactions');
    expect(normalizeRoutePathForTelemetry('/v1/webhooks/550e8400-e29b-41d4-a716-446655440000')).toBe('/v1/webhooks/:id');
  });

  it('normalizes known prefixed ids', () => {
    expect(normalizeRoutePathForTelemetry('/v1/subscriptions/sub_abc123def456')).toBe('/v1/subscriptions/:id');
    expect(normalizeRoutePathForTelemetry('/v1/webhooks/wh_k3x9q2p7z1n4')).toBe('/v1/webhooks/:id');
  });
});
