import { createSync } from 'nango';
import { z } from 'zod';

const GoogleMailLabel = z.object({
    id: z.string(),
    name: z.string(),
    type: z.string().optional(),
    messageListVisibility: z.string().optional(),
    labelListVisibility: z.string().optional(),
    messagesTotal: z.number().int().optional(),
    messagesUnread: z.number().int().optional(),
    threadsTotal: z.number().int().optional(),
    threadsUnread: z.number().int().optional(),
    textColor: z.string().optional(),
    backgroundColor: z.string().optional(),
    raw_json: z.string()
});

const GmailLabelResponseSchema = z.object({
    labels: z
        .array(
            z
                .object({
                    id: z.string(),
                    name: z.string(),
                    type: z.string().optional(),
                    messageListVisibility: z.string().optional(),
                    labelListVisibility: z.string().optional(),
                    messagesTotal: z.number().int().optional(),
                    messagesUnread: z.number().int().optional(),
                    threadsTotal: z.number().int().optional(),
                    threadsUnread: z.number().int().optional(),
                    color: z
                        .object({
                            textColor: z.string().optional(),
                            backgroundColor: z.string().optional()
                        })
                        .optional()
                })
                .passthrough()
        )
        .optional()
});

type GoogleMailLabelRecord = z.infer<typeof GoogleMailLabel>;

const sync = createSync({
    description: 'Sync Gmail labels for Relayfile.',
    version: '1.0.0',
    frequency: 'every 6 hours',
    autoStart: true,
    endpoints: [{ method: 'GET', path: '/gmail/labels', group: 'Google Mail' }],
    models: {
        GoogleMailLabel
    },
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],

    exec: async (nango) => {
        const response = await nango.get({
            // https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels/list
            endpoint: '/gmail/v1/users/me/labels',
            retries: 3
        });

        const parsed = GmailLabelResponseSchema.parse(response.data);
        const records: GoogleMailLabelRecord[] = (parsed.labels ?? []).map((label) => ({
            id: label.id,
            name: label.name,
            ...(label.type ? { type: label.type } : {}),
            ...(label.messageListVisibility ? { messageListVisibility: label.messageListVisibility } : {}),
            ...(label.labelListVisibility ? { labelListVisibility: label.labelListVisibility } : {}),
            ...(typeof label.messagesTotal === 'number' ? { messagesTotal: label.messagesTotal } : {}),
            ...(typeof label.messagesUnread === 'number' ? { messagesUnread: label.messagesUnread } : {}),
            ...(typeof label.threadsTotal === 'number' ? { threadsTotal: label.threadsTotal } : {}),
            ...(typeof label.threadsUnread === 'number' ? { threadsUnread: label.threadsUnread } : {}),
            ...(label.color?.textColor ? { textColor: label.color.textColor } : {}),
            ...(label.color?.backgroundColor ? { backgroundColor: label.color.backgroundColor } : {}),
            raw_json: JSON.stringify(label)
        }));

        await nango.trackDeletesStart('GoogleMailLabel');
        try {
            if (records.length > 0) {
                await nango.batchSave(records, 'GoogleMailLabel');
            }
        } finally {
            await nango.trackDeletesEnd('GoogleMailLabel');
        }
    }
});

export default sync;
