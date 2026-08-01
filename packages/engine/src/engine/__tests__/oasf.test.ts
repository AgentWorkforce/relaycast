import { describe, expect, it } from 'vitest';
import {
  directoryAgentToOasfRecord,
  OasfRecordSchema,
  oasfRecordToDirectoryAgentInput,
  OASF_SCHEMA_VERSION,
  type OasfExportableAgent,
} from '../oasf.js';

describe('OasfRecordSchema', () => {
  it('accepts a minimal valid record', () => {
    const parsed = OasfRecordSchema.safeParse({
      schema_version: '1.1.0',
      name: 'Billing Agent',
      description: 'Handles billing lookups',
      version: '1.0.0',
      authors: ['acme-corp'],
      skills: [{ name: 'refund-lookup' }],
    });
    expect(parsed.success).toBe(true);
  });

  it('preserves unknown fields via passthrough instead of rejecting them', () => {
    const parsed = OasfRecordSchema.safeParse({
      schema_version: '1.1.0',
      name: 'Billing Agent',
      description: 'Handles billing lookups',
      version: '1.0.0',
      authors: [],
      skills: [],
      some_future_field: { nested: true },
    });
    expect(parsed.success).toBe(true);
    expect((parsed.data as Record<string, unknown>).some_future_field).toEqual({ nested: true });
  });

  it('rejects a record missing required fields', () => {
    const parsed = OasfRecordSchema.safeParse({
      name: 'Billing Agent',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('oasfRecordToDirectoryAgentInput', () => {
  it('maps core fields, projects domains into tags, and keeps skill uids', () => {
    const record = OasfRecordSchema.parse({
      schema_version: '1.1.0',
      name: 'Billing Agent',
      description: 'Handles billing lookups',
      version: '1.0.0',
      authors: ['acme-corp'],
      created_at: '2026-01-01T00:00:00Z',
      skills: [{ name: 'refund-lookup', uid: 71601 }],
      domains: [{ name: 'finance' }, { name: 'customer-support' }],
      locators: [{ type: 'url', urls: ['https://billing.example.com'] }],
      modules: [{ name: 'a2a_data', data: { card_schema_version: '0.3.0' } }],
      annotations: { region: 'us-east' },
    });

    const input = oasfRecordToDirectoryAgentInput(record);

    expect(input.name).toBe('Billing Agent');
    expect(input.description).toBe('Handles billing lookups');
    expect(input.version).toBe('1.0.0');
    expect(input.endpoint_url).toBe('https://billing.example.com');
    expect(input.tags).toEqual(['finance', 'customer-support']);
    expect(input.skills).toEqual([{ name: 'refund-lookup', metadata: { oasf_uid: 71601 } }]);

    const stored = input.metadata?.oasf as Record<string, unknown>;
    expect(stored.schema_version).toBe('1.1.0');
    expect(stored.authors).toEqual(['acme-corp']);
    expect(stored.domains).toEqual([{ name: 'finance' }, { name: 'customer-support' }]);
    expect(stored.modules).toEqual([{ name: 'a2a_data', data: { card_schema_version: '0.3.0' } }]);
    expect(stored.annotations).toEqual({ region: 'us-east' });
  });

  it('omits endpoint_url and tags when no locators or domains are given', () => {
    const record = OasfRecordSchema.parse({
      schema_version: '1.1.0',
      name: 'Minimal Agent',
      description: 'No extras',
      version: '0.1.0',
      authors: [],
      skills: [],
    });

    const input = oasfRecordToDirectoryAgentInput(record);
    expect(input.endpoint_url).toBeUndefined();
    expect(input.tags).toEqual([]);
    expect(input.skills).toEqual([]);
  });
});

describe('directoryAgentToOasfRecord', () => {
  function baseAgent(overrides: Partial<OasfExportableAgent> = {}): OasfExportableAgent {
    return {
      name: 'Billing Agent',
      description: 'Handles billing lookups',
      provider: 'acme',
      endpoint_url: 'https://billing.example.com',
      documentation_url: 'https://billing.example.com/docs',
      version: '1.0.0',
      tags: ['finance'],
      metadata: {},
      skills: [{ name: 'refund-lookup', metadata: {} }],
      created_at: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('derives a record from a native (non-OASF-imported) directory agent', () => {
    const record = directoryAgentToOasfRecord(baseAgent());

    expect(record.schema_version).toBe(OASF_SCHEMA_VERSION);
    expect(record.name).toBe('Billing Agent');
    expect(record.description).toBe('Handles billing lookups');
    expect(record.version).toBe('1.0.0');
    expect(record.authors).toEqual(['Billing Agent']);
    expect(record.skills).toEqual([{ name: 'refund-lookup' }]);
    expect(record.domains).toEqual([{ name: 'finance' }]);
    expect(record.locators).toEqual([{ type: 'url', urls: ['https://billing.example.com'] }]);
    expect(record.annotations).toEqual({
      provider: 'acme',
      documentation_url: 'https://billing.example.com/docs',
    });
    expect(OasfRecordSchema.safeParse(record).success).toBe(true);
  });

  it('round-trips authors, domains, modules, and extra locators stashed at import time', () => {
    const imported = oasfRecordToDirectoryAgentInput(OasfRecordSchema.parse({
      schema_version: '1.1.0',
      name: 'Billing Agent',
      description: 'Handles billing lookups',
      version: '1.0.0',
      authors: ['acme-corp'],
      created_at: '2026-01-01T00:00:00Z',
      skills: [{ name: 'refund-lookup', uid: 71601 }],
      domains: [{ name: 'finance' }],
      locators: [
        { type: 'url', urls: ['https://billing.example.com'] },
        { type: 'source_code', urls: ['https://github.com/acme/billing-agent'] },
      ],
      modules: [{ name: 'a2a_data', data: { card_schema_version: '0.3.0' } }],
    }));

    const agent = baseAgent({
      metadata: imported.metadata ?? {},
      skills: [{ name: 'refund-lookup', metadata: { oasf_uid: 71601 } }],
    });

    const record = directoryAgentToOasfRecord(agent);

    expect(record.schema_version).toBe('1.1.0');
    expect(record.authors).toEqual(['acme-corp']);
    expect(record.created_at).toBe('2026-01-01T00:00:00Z');
    expect(record.skills).toEqual([{ name: 'refund-lookup', uid: 71601 }]);
    expect(record.modules).toEqual([{ name: 'a2a_data', data: { card_schema_version: '0.3.0' } }]);
    // Native endpoint_url stays first; the extra imported locator is preserved after it.
    expect(record.locators).toEqual([
      { type: 'url', urls: ['https://billing.example.com'] },
      { type: 'source_code', urls: ['https://github.com/acme/billing-agent'] },
    ]);
    expect(OasfRecordSchema.safeParse(record).success).toBe(true);
  });

  it('falls back to sane defaults when description/version/tags are absent', () => {
    const record = directoryAgentToOasfRecord(baseAgent({
      description: null,
      version: null,
      tags: [],
      endpoint_url: null,
      provider: null,
      documentation_url: null,
    }));

    expect(record.description).toBe('Billing Agent');
    expect(record.version).toBe('0.0.0');
    expect(record.domains).toBeUndefined();
    expect(record.locators).toBeUndefined();
    expect(record.annotations).toBeUndefined();
    expect(OasfRecordSchema.safeParse(record).success).toBe(true);
  });
});
