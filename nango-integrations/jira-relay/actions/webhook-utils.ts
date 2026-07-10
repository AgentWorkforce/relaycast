import type { NangoAction } from 'nango';
import { z } from 'zod';

export const MetadataSchema = z.object({
  cloudId: z.string().optional(),
  baseUrl: z.string().optional(),
});

export const AccessibleResourcesSchema = z.array(
  z.object({
    id: z.string(),
    url: z.string().optional(),
  }),
);

export const JiraWebhookFilters = z.record(z.string(), z.string());

export const JiraWebhook = z.object({
  id: z.string(),
  self: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  url: z.string(),
  events: z.array(z.string()),
  filters: JiraWebhookFilters.optional(),
  jqlFilter: z.string().optional(),
  fieldIdsFilter: z.array(z.string()).optional(),
  issuePropertyKeysFilter: z.array(z.string()).optional(),
  expirationDate: z.string().optional(),
  excludeBody: z.boolean().optional(),
  enabled: z.boolean().optional(),
  isSigned: z.boolean().optional(),
});

export const JiraWebhookPayload = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  url: z.string().url(),
  events: z.array(z.string().min(1)).min(1),
  filters: JiraWebhookFilters.optional(),
  jqlFilter: z.string().optional(),
  fieldIdsFilter: z.array(z.string()).optional(),
  issuePropertyKeysFilter: z.array(z.string()).optional(),
  excludeBody: z.boolean().optional(),
  enabled: z.boolean().optional(),
  secret: z.union([z.string().min(1), z.null()]).optional(),
});

export const WebhookIdInput = z.object({
  webhookId: z.union([
    z.string().min(1).refine((value) => value.trim().length > 0, {
      message: 'webhookId cannot be empty or only whitespace',
    }),
    z.number().int().positive(),
  ]),
});

export const RefreshWebhookOutput = z.object({
  success: z.boolean(),
  webhookId: z.string(),
  expirationDate: z.string().optional(),
});

const ProviderWebhookSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    self: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    url: z.string().optional(),
    events: z.array(z.string()).optional(),
    filters: JiraWebhookFilters.optional(),
    jqlFilter: z.string().optional(),
    fieldIdsFilter: z.array(z.string()).optional(),
    issuePropertyKeysFilter: z.array(z.string()).optional(),
    expirationDate: z.string().optional(),
    excludeBody: z.boolean().optional(),
    enabled: z.boolean().optional(),
    isSigned: z.boolean().optional(),
  })
  .passthrough();

export type JiraWebhookRecord = z.infer<typeof JiraWebhook>;

type JiraAction = Pick<NangoAction, 'get' | 'getConnection' | 'getMetadata' | 'post' | 'put' | 'delete' | 'updateMetadata' | 'ActionError'>;

export async function getJiraSite(nango: JiraAction): Promise<{ cloudId: string; baseUrl: string }> {
  const metadata = MetadataSchema.parse((await nango.getMetadata()) ?? {});
  if (metadata.cloudId && metadata.baseUrl) {
    return { cloudId: metadata.cloudId, baseUrl: metadata.baseUrl };
  }

  const connection = await nango.getConnection();
  const configCloudId = connection.connection_config?.['cloudId'];
  const configBaseUrl = connection.connection_config?.['baseUrl'];
  if (typeof configCloudId === 'string' && typeof configBaseUrl === 'string') {
    return { cloudId: configCloudId, baseUrl: configBaseUrl };
  }

  const response = await nango.get({
    // https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/#2-get-the-cloudid-for-your-site
    endpoint: 'oauth/token/accessible-resources',
    baseUrlOverride: 'https://api.atlassian.com',
    retries: 3,
  });

  const resources = AccessibleResourcesSchema.parse(response.data);
  const resource = selectAccessibleResource(resources, {
    cloudId: typeof configCloudId === 'string' ? configCloudId : metadata.cloudId,
    baseUrl: typeof configBaseUrl === 'string' ? configBaseUrl : metadata.baseUrl,
  });
  if (!resource?.id || !resource.url) {
    throw new nango.ActionError({
      type: 'no_accessible_jira_resource',
      message:
        resources.length > 1
          ? `Multiple accessible Jira resources found (${resources
              .map((item) => `${item.id}:${item.url ?? 'unknown-url'}`)
              .join(', ')}); configure cloudId/baseUrl metadata before running this action.`
          : 'No accessible Jira resource found for this connection.',
    });
  }

  const updateMetadata = nango.updateMetadata as unknown as (value: z.infer<typeof MetadataSchema>) => Promise<void>;
  await updateMetadata({ ...metadata, cloudId: resource.id, baseUrl: resource.url });
  return { cloudId: resource.id, baseUrl: resource.url };
}

export function toWebhookId(value: z.infer<typeof WebhookIdInput>['webhookId']): string {
  const webhookId = String(value).trim();
  if (!webhookId) {
    throw new Error('webhookId must be a non-empty value.');
  }
  return webhookId;
}

export function normalizeWebhook(providerWebhook: unknown): JiraWebhookRecord {
  const parsed = ProviderWebhookSchema.parse(providerWebhook);
  const id = parsed.id === undefined ? idFromSelf(parsed.self) : String(parsed.id);

  if (!id) {
    throw new Error('Jira webhook response did not include an id or self URL.');
  }

  return JiraWebhook.parse({
    id,
    ...(parsed.self ? { self: parsed.self } : {}),
    ...(parsed.name ? { name: parsed.name } : {}),
    ...(parsed.description ? { description: parsed.description } : {}),
    url: parsed.url ?? '',
    events: parsed.events ?? [],
    ...(parsed.filters ? { filters: parsed.filters } : {}),
    ...(parsed.jqlFilter ? { jqlFilter: parsed.jqlFilter } : {}),
    ...(parsed.fieldIdsFilter ? { fieldIdsFilter: parsed.fieldIdsFilter } : {}),
    ...(parsed.issuePropertyKeysFilter ? { issuePropertyKeysFilter: parsed.issuePropertyKeysFilter } : {}),
    ...(parsed.expirationDate ? { expirationDate: parsed.expirationDate } : {}),
    ...(parsed.excludeBody !== undefined ? { excludeBody: parsed.excludeBody } : {}),
    ...(parsed.enabled !== undefined ? { enabled: parsed.enabled } : {}),
    ...(parsed.isSigned !== undefined ? { isSigned: parsed.isSigned } : {}),
  });
}

export function dynamicWebhookEndpoint(cloudId: string, suffix = ''): string {
  return `/ex/jira/${cloudId}/rest/api/3/webhook${suffix}`;
}

export function toDynamicWebhookDetails(input: z.infer<typeof JiraWebhookPayload>): Record<string, unknown> {
  return {
    events: input.events,
    jqlFilter: input.jqlFilter ?? input.filters?.['issue-related-events-section'] ?? '',
    ...(input.fieldIdsFilter !== undefined ? { fieldIdsFilter: input.fieldIdsFilter } : {}),
    ...(input.issuePropertyKeysFilter !== undefined ? { issuePropertyKeysFilter: input.issuePropertyKeysFilter } : {}),
  };
}

function idFromSelf(self: string | undefined): string {
  if (!self) {
    return '';
  }

  const normalized = normalizeSelfUrl(self);
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? '';
}

function normalizeSelfUrl(self: string): string {
  try {
    const url = new URL(self);
    return url.pathname;
  } catch {
    return self.split(/[?#]/, 1)[0] ?? '';
  }
}

function selectAccessibleResource(
  resources: Array<{ id: string; url?: string | undefined }>,
  hint: { cloudId?: string | undefined; baseUrl?: string | undefined },
): { id: string; url?: string | undefined } | undefined {
  const normalizedHintUrl = normalizeBaseUrl(hint.baseUrl);
  const hinted = resources.find(
    (resource) =>
      (hint.cloudId && resource.id === hint.cloudId) ||
      (normalizedHintUrl && normalizeBaseUrl(resource.url) === normalizedHintUrl),
  );
  if (hinted) {
    return hinted;
  }

  if (hint.cloudId || hint.baseUrl) {
    return undefined;
  }

  if (resources.length === 1) {
    return resources[0];
  }

  return undefined;
}

function normalizeBaseUrl(url: string | undefined): string | undefined {
  return url?.replace(/\/+$/, '');
}
