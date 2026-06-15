import { describe, it, expect } from 'vitest';
import {
  parseTelemetryIngestionEvent,
  parseInternalTelemetryEvent,
  normalizeTelemetryOrigin,
  sanitizeTelemetryProperties,
} from '../telemetry.js';

describe('telemetry schemas', () => {
  it('parses client ingestion events and strips blocked properties', () => {
    const parsed = parseTelemetryIngestionEvent({
      event: 'relaycast_cli_started',
      distinct_id: 'anon-123',
      properties: {
        source_surface: 'cli',
        command_count: 2,
        api_key: 'must-not-pass',
      },
    });

    expect(parsed.event).toBe('relaycast_cli_started');
    expect(parsed.properties.source_surface).toBe('cli');
    expect(parsed.properties.command_count).toBe(2);
    expect(parsed.properties.api_key).toBeUndefined();
  });

  it('rejects unknown ingestion event names', () => {
    expect(() => parseTelemetryIngestionEvent({
      event: 'custom_event',
      distinct_id: 'anon-123',
      properties: {},
    })).toThrow();
  });

  it('requires origin fields for internal events', () => {
    expect(() => parseInternalTelemetryEvent({
      event: 'relaycast_server_search_executed',
      distinct_id: 'workspace:ws_123',
      properties: {
        workspace_id: 'ws_123',
        query_length: 4,
        result_count: 1,
      },
    })).toThrow();
  });

  it('validates required server event properties', () => {
    expect(() => parseInternalTelemetryEvent({
      event: 'relaycast_server_search_executed',
      distinct_id: 'workspace:ws_123',
      origin_client: '@relaycast/sdk-ts',
      origin_version: '0.3.1',
      properties: {
        workspace_id: 'ws_123',
      },
    })).toThrow(/Missing required properties/);
  });

  it('normalizes missing origin values to unknown', () => {
    const origin = normalizeTelemetryOrigin({});
    expect(origin).toEqual({
      origin_client: 'unknown',
      origin_version: 'unknown',
    });
  });

  it('caps/filters sanitization results', () => {
    const properties = sanitizeTelemetryProperties({
      '': 'skip',
      'invalid key': 'skip',
      ok: 'value',
      token: 'skip',
      nested: { hello: 'world' },
    });

    expect(properties).toEqual({
      ok: 'value',
      nested: '{"hello":"world"}',
    });
  });
});
