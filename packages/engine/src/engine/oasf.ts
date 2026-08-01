import { z } from 'zod';

// Practical subset of the AGNTCY Open Agent Schema Framework (OASF) Agent
// Record — https://schema.oasf.outshift.com/1.1.0/objects/record — covering
// the fields relaycast's directory can round-trip. Unknown fields on import
// are preserved via `.passthrough()` but not interpreted.
export const OASF_SCHEMA_VERSION = '1.1.0';

export const OasfLocatorSchema = z.object({
  type: z.enum(['binary', 'container_image', 'helm_chart', 'package', 'source_code', 'unspecified', 'url']).optional(),
  urls: z.array(z.string().url()).min(1),
  annotations: z.record(z.string(), z.string()).optional(),
}).passthrough();
export type OasfLocator = z.infer<typeof OasfLocatorSchema>;

export const OasfSkillRefSchema = z.object({
  name: z.string().min(1),
  uid: z.number().optional(),
}).passthrough();
export type OasfSkillRef = z.infer<typeof OasfSkillRefSchema>;

export const OasfDomainRefSchema = z.object({
  name: z.string().min(1),
  uid: z.number().optional(),
}).passthrough();
export type OasfDomainRef = z.infer<typeof OasfDomainRefSchema>;

export const OasfModuleSchema = z.object({
  name: z.string().min(1),
  data: z.unknown().optional(),
}).passthrough();
export type OasfModule = z.infer<typeof OasfModuleSchema>;

export const OasfRecordSchema = z.object({
  schema_version: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string().min(1),
  authors: z.array(z.string()).default([]),
  created_at: z.string().optional(),
  skills: z.array(OasfSkillRefSchema).default([]),
  domains: z.array(OasfDomainRefSchema).optional(),
  locators: z.array(OasfLocatorSchema).optional(),
  modules: z.array(OasfModuleSchema).optional(),
  annotations: z.record(z.string(), z.string()).optional(),
}).passthrough();
export type OasfRecord = z.infer<typeof OasfRecordSchema>;

interface StoredOasfExtras {
  schema_version?: string;
  authors?: string[];
  created_at?: string;
  domains?: OasfDomainRef[];
  locators?: OasfLocator[];
  modules?: OasfModule[];
  annotations?: Record<string, string>;
}

// Matches the subset of DirectoryAgentInput (see engine/directory.ts) an OASF
// record can populate. Kept structurally independent to avoid a circular
// import between oasf.ts and directory.ts.
export interface OasfDirectoryAgentInput {
  name: string;
  description?: string;
  version?: string;
  endpoint_url?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  skills?: Array<{ name: string; metadata?: Record<string, unknown> }>;
}

// A serialized directory agent (see serializeDirectoryAgent in
// engine/directory.ts) has more fields than this function reads; only the
// ones needed to build an OASF record are declared.
export interface OasfExportableAgent {
  name: string;
  description: string | null;
  provider: string | null;
  endpoint_url: string | null;
  documentation_url: string | null;
  version: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  skills: Array<{ name: string; metadata: Record<string, unknown> }>;
  created_at: string;
}

// Only a `url`-typed locator is a reachable HTTP endpoint — a container_image,
// helm_chart, or source_code locator is a place to *get* the agent, not a
// place to *call* it, so those must never populate endpoint_url.
function firstLocatorUrl(locators?: OasfLocator[]): string | undefined {
  return locators?.find((locator) => locator.type === 'url' && locator.urls.length > 0)?.urls[0];
}

/**
 * Convert an OASF Agent Record into directory-agent create/update input.
 * Domains project into `tags` for relaycast's own search/routing (a lossy,
 * one-way convenience — the authoritative `domains` array is preserved in
 * `metadata.oasf` for export). Any locator, module, author, or annotation
 * data that relaycast has no native field for is kept losslessly under
 * `metadata.oasf` as well.
 */
export function oasfRecordToDirectoryAgentInput(record: OasfRecord): OasfDirectoryAgentInput {
  const extras: StoredOasfExtras = {
    schema_version: record.schema_version,
    authors: record.authors,
    created_at: record.created_at,
    domains: record.domains,
    locators: record.locators,
    modules: record.modules,
    annotations: record.annotations,
  };

  return {
    name: record.name,
    description: record.description,
    version: record.version,
    endpoint_url: firstLocatorUrl(record.locators),
    tags: (record.domains ?? []).map((domain) => domain.name),
    skills: record.skills.map((skill) => ({
      name: skill.name,
      metadata: skill.uid !== undefined ? { oasf_uid: skill.uid } : undefined,
    })),
    metadata: { oasf: extras },
  };
}

/**
 * Convert a serialized directory agent into an OASF Agent Record. Core
 * fields (name, description, version, skills, endpoint) are derived live
 * from the agent's current state so edits made through the normal directory
 * API stay reflected in exports; fields OASF has no relaycast equivalent for
 * (authors, domains, extra locators, modules) are restored from whatever was
 * stashed in `metadata.oasf` at import time, if any.
 */
export function directoryAgentToOasfRecord(agent: OasfExportableAgent): OasfRecord {
  const stored = (agent.metadata?.oasf ?? {}) as StoredOasfExtras;

  const locators: OasfLocator[] = [];
  if (agent.endpoint_url) {
    locators.push({ type: 'url', urls: [agent.endpoint_url] });
  }
  for (const locator of stored.locators ?? []) {
    if (!agent.endpoint_url || !locator.urls.includes(agent.endpoint_url)) {
      locators.push(locator);
    }
  }

  const annotations: Record<string, string> = { ...stored.annotations };
  if (agent.provider) annotations.provider = agent.provider;
  if (agent.documentation_url) annotations.documentation_url = agent.documentation_url;

  const domains = stored.domains?.length
    ? stored.domains
    : agent.tags.length
      ? agent.tags.map((tag) => ({ name: tag }))
      : undefined;

  return {
    schema_version: stored.schema_version ?? OASF_SCHEMA_VERSION,
    name: agent.name,
    description: agent.description || agent.name,
    version: agent.version || '0.0.0',
    authors: stored.authors?.length ? stored.authors : [agent.name],
    created_at: stored.created_at ?? agent.created_at,
    skills: agent.skills.map((skill) => {
      const uid = skill.metadata?.oasf_uid;
      return typeof uid === 'number' ? { name: skill.name, uid } : { name: skill.name };
    }),
    ...(domains ? { domains } : {}),
    ...(locators.length ? { locators } : {}),
    ...(stored.modules?.length ? { modules: stored.modules } : {}),
    ...(Object.keys(annotations).length ? { annotations } : {}),
  };
}
