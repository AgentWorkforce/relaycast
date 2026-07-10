import { createSync } from 'nango';
import { z } from 'zod';

const MetadataSchema = z.object({
  cloudId: z.string().optional(),
  baseUrl: z.string().optional(),
});

const CheckpointSchema = z.object({
  deleteTrackingStarted: z.boolean(),
  startAt: z.number(),
});

const AccessibleResourcesSchema = z.array(
  z.object({
    id: z.string(),
    url: z.string().optional(),
  }),
);

const ProviderProjectSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  self: z.string().optional(),
  projectTypeKey: z.string().optional(),
  simplified: z.boolean().optional(),
  style: z.string().optional(),
  isPrivate: z.boolean().optional(),
  entityId: z.string().optional(),
  uuid: z.string().optional(),
  lead: z
    .object({
      accountId: z.string().optional(),
      displayName: z.string().optional(),
    })
    .optional(),
  projectCategory: z
    .object({
      id: z.string(),
      name: z.string(),
      description: z.string().optional(),
    })
    .optional(),
  avatarUrls: z.record(z.string(), z.string()).optional(),
});
const DeletedProjectSchema = z.object({
  id: z.string(),
});

const ProjectSearchResponseSchema = z.object({
  values: z.array(ProviderProjectSchema).optional(),
  startAt: z.number().optional(),
  maxResults: z.number().optional(),
  total: z.number().optional(),
  isLast: z.boolean().optional(),
});

const JiraProject = ProviderProjectSchema.extend({
  web_url: z.string().optional(),
});

type JiraProjectRecord = z.infer<typeof JiraProject>;
type NangoSyncLocal = Parameters<(typeof sync)['exec']>[0];

const sync = createSync({
  description: 'Syncs Jira projects accessible to the authenticated user for Relayfile.',
  version: '1.0.0',
  frequency: 'every 12 hours',
  autoStart: true,
  endpoints: [{ method: 'GET', path: '/jira/projects', group: 'Jira' }],
  metadata: MetadataSchema,
  checkpoint: CheckpointSchema,
  models: {
    JiraProject,
  },
  // `read:jira-work` is the *stable* required scope for GET /rest/api/3/project/search;
  // the granular alternatives below are still Beta in Atlassian's OpenAPI spec.
  // A pure-granular token 401s with `Unauthorized; scope does not match`. Hybrid keeps
  // classic stable + granular forward-compatible.
  scopes: [
    'read:jira-work',
    'read:project:jira',
    'read:project.property:jira',
    'read:project-category:jira',
    'read:user:jira',
    'read:application-role:jira',
    'read:avatar:jira',
    'read:issue-type:jira',
    'read:group:jira',
    'read:issue-type-hierarchy:jira',
    'read:project-version:jira',
    'read:project.component:jira',
  ],
  webhookSubscriptions: ['project_created', 'project_updated', 'project_deleted', 'jira:project_created', 'jira:project_updated', 'jira:project_deleted'],

  exec: async (nango) => {
    const site = await getJiraSite(nango);
    const parsedCheckpoint = CheckpointSchema.safeParse(await nango.getCheckpoint());
    const checkpoint = parsedCheckpoint.success
      ? parsedCheckpoint.data
      : { deleteTrackingStarted: false, startAt: 0 };
    let startAt = checkpoint.startAt;

    if (!checkpoint.deleteTrackingStarted) {
      await nango.trackDeletesStart('JiraProject');
      await nango.saveCheckpoint({ deleteTrackingStarted: true, startAt });
    }

    while (true) {
      const response = await nango.get({
        // https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-projects/#api-rest-api-3-project-search-get
        endpoint: `/ex/jira/${site.cloudId}/rest/api/3/project/search`,
        params: {
          startAt,
          maxResults: 50,
        },
        retries: 3,
      });

      const data = ProjectSearchResponseSchema.parse(response.data);
      const projects = (data.values ?? []).map((project): JiraProjectRecord => ({
        ...project,
        web_url: `${site.baseUrl}/jira/software/projects/${project.key}`,
      }));

      if (projects.length > 0) {
        await nango.batchSave(projects, 'JiraProject');
      }

      const nextStartAt = startAt + (data.maxResults ?? projects.length);
      const hasMore = data.isLast === false || (data.total !== undefined && nextStartAt < data.total);
      if (!hasMore || projects.length === 0) {
        break;
      }

      startAt = nextStartAt;
      await nango.saveCheckpoint({ deleteTrackingStarted: true, startAt });
    }

    await nango.trackDeletesEnd('JiraProject');
    await nango.clearCheckpoint();
  },

  onWebhook: async (nango, payload) => {
    const webhook = payload as { webhookEvent?: string; project?: unknown };
    const rawProject = webhook.project ?? payload;
    const event = (webhook.webhookEvent ?? '').toLowerCase();
    if (event.includes('deleted')) {
      const deleted = DeletedProjectSchema.safeParse(rawProject);
      if (!deleted.success) {
        await nango.log('Jira project delete webhook skipped because project.id was missing.', { level: 'warn' });
        return;
      }
      await nango.batchDelete([{ id: deleted.data.id }], 'JiraProject');
      return;
    }

    const project = ProviderProjectSchema.safeParse(rawProject);
    if (!project.success) {
      await nango.log('Jira project webhook skipped because the project payload was missing or invalid.', { level: 'warn' });
      return;
    }

    const site = await getJiraSite(nango);
    await nango.batchSave(
      [
        {
          ...project.data,
          web_url: `${site.baseUrl}/jira/software/projects/${project.data.key}`,
        },
      ],
      'JiraProject',
    );
  },
});

async function getJiraSite(nango: NangoSyncLocal): Promise<{ cloudId: string; baseUrl: string }> {
  const metadata = await getMetadata(nango);
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
    throw new Error(
      resources.length > 1
        ? `Multiple accessible Jira resources found (${resources
            .map((item) => `${item.id}:${item.url ?? 'unknown-url'}`)
            .join(', ')}); configure cloudId/baseUrl metadata before syncing.`
        : 'No accessible Jira resource found.',
    );
  }

  await nango.updateMetadata({ ...metadata, cloudId: resource.id, baseUrl: resource.url });
  return { cloudId: resource.id, baseUrl: resource.url };
}

async function getMetadata(nango: NangoSyncLocal): Promise<z.infer<typeof MetadataSchema>> {
  try {
    return MetadataSchema.parse((await nango.getMetadata()) ?? {});
  } catch {
    return {};
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

export default sync;
