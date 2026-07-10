import { createOnEvent } from 'nango';
import * as z from 'zod';

import { getRequiredNangoWebhookConfig, hasEventOverlap, missingEvents, sameWebhookUrl } from '../../shared/webhook-setup.js';

const JiraWebhook = z.object({
    id: z.string(),
    url: z.string(),
    events: z.array(z.string())
}).passthrough();

const ListWebhooksResult = z.object({
    webhooks: z.array(JiraWebhook)
});

const JIRA_SYNC_WEBHOOK_EVENTS = [
    'jira:issue_created',
    'jira:issue_updated',
    'jira:issue_deleted',
    'project_created',
    'project_updated',
    'project_deleted',
    'sprint_created',
    'sprint_updated',
    'sprint_started',
    'sprint_closed',
    'sprint_deleted'
] as const;

const setupWebhooks = createOnEvent({
    event: 'post-connection-creation',
    description: 'Register Jira dynamic webhooks for synced issues, projects, and sprints.',
    version: '1.0.0',
    metadata: z.object({}),

    exec: async (nango): Promise<void> => {
        const webhookConfig = await getRequiredNangoWebhookConfig(nango);
        const existing = await nango.triggerAction<Record<string, never>, z.infer<typeof ListWebhooksResult>>(
            'jira-relay',
            nango.connectionId,
            'list-webhooks',
            {}
        );
        const matching = existing.webhooks.filter((webhook) => sameWebhookUrl(webhook.url, webhookConfig.url));
        const current = matching.find((webhook) => hasEventOverlap(webhook.events, JIRA_SYNC_WEBHOOK_EVENTS));

        if (current) {
            const coveredEvents = [...new Set(matching.flatMap((webhook) => webhook.events))];
            const addEvents = missingEvents(coveredEvents, JIRA_SYNC_WEBHOOK_EVENTS);
            if (addEvents.length > 0) {
                await nango.triggerAction('jira-relay', nango.connectionId, 'register-webhook', {
                    url: webhookConfig.url,
                    events: addEvents,
                    jqlFilter: ''
                });
            }

            await nango.triggerAction('jira-relay', nango.connectionId, 'update-webhook', {
                webhookId: current.id
            });

            await nango.log(
                addEvents.length > 0
                    ? `Jira webhook setup refreshed existing dynamic webhook ${current.id} and registered ${addEvents.length} missing events.`
                    : `Jira webhook setup refreshed existing dynamic webhook ${current.id}.`
            );
            return;
        }

        await nango.triggerAction('jira-relay', nango.connectionId, 'register-webhook', {
            url: webhookConfig.url,
            events: [...JIRA_SYNC_WEBHOOK_EVENTS],
            jqlFilter: ''
        });

        await nango.log('Jira webhook setup registered dynamic webhooks for synced issues, projects, and sprints.');
    }
});

export default setupWebhooks;
