import { createSync } from 'nango';
import { z } from 'zod';

const MetadataSchema = z.object({
  cloudId: z.string().optional(),
  baseUrl: z.string().optional(),
  jql: z.string().optional(),
});

const CheckpointSchema = z.object({
  deleteTrackingStarted: z.boolean(),
  nextPageToken: z.string(),
  jql: z.string(),
});

const AccessibleResourcesSchema = z.array(
  z.object({
    id: z.string(),
    url: z.string().optional(),
  }),
);

const JiraUserSchema = z
  .union([
    z.object({
      accountId: z.string().optional(),
      displayName: z.string().optional(),
      emailAddress: z.string().optional(),
      timeZone: z.string().optional(),
      self: z.string().optional(),
      avatarUrls: z.record(z.string(), z.string()).optional(),
    }),
    z.null(),
  ])
  .optional();

const JiraIssueFieldsSchema = z.object({
  summary: z.string().optional(),
  description: z.unknown().optional(),
  status: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
      statusCategory: z
        .object({
          key: z.string().optional(),
          name: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  issuetype: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
      subtask: z.boolean().optional(),
    })
    .optional(),
  priority: z
    .union([
      z.object({
        id: z.string().optional(),
        name: z.string().optional(),
      }),
      z.null(),
    ])
    .optional(),
  project: z
    .object({
      id: z.string().optional(),
      key: z.string().optional(),
      name: z.string().optional(),
    })
    .optional(),
  reporter: JiraUserSchema,
  assignee: JiraUserSchema,
  creator: JiraUserSchema,
  created: z.string().optional(),
  updated: z.string().optional(),
  resolutiondate: z.union([z.string(), z.null()]).optional(),
  duedate: z.union([z.string(), z.null()]).optional(),
  labels: z.array(z.string()).optional(),
});

const ProviderIssueSchema = z.object({
  id: z.string(),
  key: z.string(),
  self: z.string(),
  fields: JiraIssueFieldsSchema.optional(),
});
const DeletedIssueSchema = z.object({
  id: z.string(),
});

const SearchResponseSchema = z.object({
  issues: z.array(ProviderIssueSchema).optional(),
  nextPageToken: z.string().optional(),
  isLast: z.boolean().optional(),
});

const JiraIssue = ProviderIssueSchema.extend({
  web_url: z.string().optional(),
});

type JiraIssueRecord = z.infer<typeof JiraIssue>;
type NangoSyncLocal = Parameters<(typeof sync)['exec']>[0];

const sync = createSync({
  description: 'Syncs Jira issues through JQL search for Relayfile.',
  version: '1.0.0',
  frequency: 'every 12 hours',
  autoStart: true,
  endpoints: [{ method: 'GET', path: '/jira/issues', group: 'Jira' }],
  metadata: MetadataSchema,
  checkpoint: CheckpointSchema,
  models: {
    JiraIssue,
  },
  // `read:jira-work` is the *stable* required scope for GET /rest/api/3/search/jql;
  // its granular alternatives (read:issue-details:jira, read:audit-log:jira,
  // read:avatar:jira, read:field-configuration:jira, read:issue-meta:jira) are
  // still marked Beta in Atlassian's OpenAPI spec and are not yet honored — a
  // pure-granular token 401s with `Unauthorized; scope does not match`. We keep
  // the broader granular set alongside classic for future-proofing and so the
  // beta path activates whenever Atlassian promotes it to stable.
  scopes: [
    'read:jira-work',
    'read:jql:jira',
    'read:issue:jira',
    'read:issue-meta:jira',
    'read:issue-details:jira',
    'read:issue.changelog:jira',
    'read:issue-link:jira',
    'read:status:jira',
    'read:issue-type:jira',
    'read:comment:jira',
    'read:attachment:jira',
    'read:project:jira',
    'read:user:jira',
    'read:application-role:jira',
    'read:avatar:jira',
    'read:group:jira',
    'read:audit-log:jira',
    'read:field-configuration:jira',
  ],
  webhookSubscriptions: ['jira:issue_created', 'jira:issue_updated', 'jira:issue_deleted'],

  exec: async (nango) => {
    const metadata = await getMetadata(nango);
    const site = await getJiraSite(nango, metadata);
    const configuredJql = normalizeJql(metadata.jql);
    const parsedCheckpoint = CheckpointSchema.safeParse(await nango.getCheckpoint());
    const checkpoint = parsedCheckpoint.success
      ? parsedCheckpoint.data
      : { deleteTrackingStarted: false, nextPageToken: '', jql: '' };
    const checkpointMatchesJql = checkpoint.jql === configuredJql;
    let nextPageToken = checkpointMatchesJql ? checkpoint.nextPageToken : '';

    if (!checkpointMatchesJql || !checkpoint.deleteTrackingStarted) {
      await nango.trackDeletesStart('JiraIssue');
      nextPageToken = '';
      await nango.saveCheckpoint({ deleteTrackingStarted: true, jql: configuredJql, nextPageToken });
    }

    const finalJql = configuredJql
      ? `${configuredJql} ORDER BY updated ASC`
      : 'updated >= "1970-01-01" ORDER BY updated ASC';

    do {
      const response = await nango.get({
        // https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/#api-rest-api-3-search-jql-get
        endpoint: `/ex/jira/${site.cloudId}/rest/api/3/search/jql`,
        params: {
          jql: finalJql,
          fields:
            'summary,description,status,issuetype,priority,project,assignee,created,updated,resolutiondate,duedate,labels',
          maxResults: 50,
          ...(nextPageToken ? { nextPageToken } : {}),
        },
        headers: {
          'X-Atlassian-Token': 'no-check',
        },
        retries: 3,
      });

      const data = SearchResponseSchema.parse(response.data);
      const issues = (data.issues ?? []).map((issue): JiraIssueRecord => ({
        ...issue,
        web_url: `${site.baseUrl}/browse/${issue.key}`,
      }));

      if (issues.length > 0) {
        await nango.batchSave(issues, 'JiraIssue');
      }

      nextPageToken = data.nextPageToken ?? '';
      if (nextPageToken) {
        await nango.saveCheckpoint({ deleteTrackingStarted: true, jql: configuredJql, nextPageToken });
      }
    } while (nextPageToken);

    await nango.trackDeletesEnd('JiraIssue');
    await nango.clearCheckpoint();
  },

  onWebhook: async (nango, payload) => {
    const webhook = payload as { webhookEvent?: string; issue?: unknown };
    const event = (webhook.webhookEvent ?? '').toLowerCase();
    if (event.includes('deleted')) {
      const deleted = DeletedIssueSchema.safeParse(webhook.issue);
      if (!deleted.success) {
        await nango.log('Jira issue delete webhook skipped because issue.id was missing.', { level: 'warn' });
        return;
      }
      await nango.batchDelete([{ id: deleted.data.id }], 'JiraIssue');
      return;
    }

    const issue = ProviderIssueSchema.safeParse(webhook.issue);
    if (!issue.success) {
      await nango.log('Jira issue webhook skipped because payload.issue was missing or invalid.', { level: 'warn' });
      return;
    }

    const metadata = await getMetadata(nango);
    const site = await getJiraSite(nango, metadata);
    await nango.batchSave(
      [
        {
          ...issue.data,
          web_url: `${site.baseUrl}/browse/${issue.data.key}`,
        },
      ],
      'JiraIssue',
    );
  },
});

async function getJiraSite(
  nango: NangoSyncLocal,
  metadata: z.infer<typeof MetadataSchema>,
): Promise<{ cloudId: string; baseUrl: string }> {
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
  const hint = {
    cloudId: typeof configCloudId === 'string' ? configCloudId : metadata.cloudId,
    baseUrl: typeof configBaseUrl === 'string' ? configBaseUrl : metadata.baseUrl,
  };
  const resource = selectAccessibleResource(resources, hint);
  if (!resource?.id) {
    if (resources.length === 0) {
      throw new Error(
        'No accessible Jira resource was returned by Atlassian /oauth/token/accessible-resources. ' +
          'Re-authorize the Nango Jira connection and ensure the user granted the required Jira OAuth scopes (see INTEGRATION_SCOPES.md — at minimum classic read:jira-work alongside the granular set) for at least one site.',
      );
    }

    const siteList = formatAccessibleResources(resources);
    if (hint.cloudId || hint.baseUrl) {
      throw new Error(
        `Configured Jira cloudId/baseUrl (cloudId=${hint.cloudId ?? 'unset'}, ` +
          `baseUrl=${hint.baseUrl ?? 'unset'}) does not match any accessible Atlassian site. ` +
          `Available sites:\n${siteList}\n` +
          'Update connection metadata cloudId/baseUrl to one of the entries above, or re-authorize the connection.',
      );
    }

    // Multiple accessible sites with no operator-provided hint. Refuse to auto-pick — picking
    // the first one (the historical behaviour, and the pattern still used by the upstream
    // NangoHQ/integration-templates jira issues.ts) silently syncs the wrong tenant and surfaces
    // as "zero issues" for users whose data lives in a different site. Mirror the safer
    // upstream pattern from integration-templates jira/syncs/projects.ts and jira/syncs/fields.ts
    // which require cloudId in metadata or connection config and throw with the list of
    // available sites.
    throw new Error(
      `Multiple accessible Jira sites found for this connection; refusing to auto-select. ` +
        `Set metadata.cloudId (and metadata.baseUrl) to one of the following before re-running the sync:\n${siteList}`,
    );
  }
  if (!resource.url) {
    throw new Error(
      `Selected Jira site (cloudId=${resource.id}) has no base URL in Atlassian accessible-resources. ` +
        'Update connection metadata.baseUrl manually or re-authorize the connection.',
    );
  }

  await nango.log(
    `Auto-selected the only accessible Jira site (cloudId=${resource.id}, baseUrl=${resource.url}).`,
  );
  await nango.updateMetadata({ ...metadata, cloudId: resource.id, baseUrl: resource.url });
  return { cloudId: resource.id, baseUrl: resource.url };
}

function formatAccessibleResources(
  resources: Array<{ id: string; url?: string | undefined }>,
): string {
  return resources
    .map((item) => `  - cloudId=${item.id} baseUrl=${item.url ?? 'unknown-url'}`)
    .join('\n');
}

async function getMetadata(nango: NangoSyncLocal): Promise<z.infer<typeof MetadataSchema>> {
  try {
    return MetadataSchema.parse((await nango.getMetadata()) ?? {});
  } catch {
    return {};
  }
}

function normalizeJql(jql: string | undefined): string {
  return (jql ?? '').replace(/\s+ORDER\s+BY[\s\S]*$/i, '').trim();
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
