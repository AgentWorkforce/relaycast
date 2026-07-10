import { createSync } from 'nango';
import { z } from 'zod';

const SmtpMsaSchema = z.object({
    host: z.string().optional(),
    port: z.number().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    securityMode: z.string().optional()
});

const GoogleMailSendAsAlias = z.object({
    id: z.string(),
    sendAsEmail: z.string(),
    displayName: z.string().optional(),
    replyToAddress: z.string().optional(),
    signature: z.string().optional(),
    isPrimary: z.boolean().optional(),
    isDefault: z.boolean().optional(),
    verificationStatus: z.string().optional(),
    treatAsAlias: z.boolean().optional(),
    smtpMsa: SmtpMsaSchema.optional()
});

const ProviderResponseSchema = z.object({
    sendAs: z.array(z.unknown())
});

const SendAsItemSchema = z.object({
    sendAsEmail: z.string(),
    displayName: z.string().optional(),
    replyToAddress: z.string().optional(),
    signature: z.string().optional(),
    isPrimary: z.boolean().optional(),
    isDefault: z.boolean().optional(),
    verificationStatus: z.string().optional(),
    treatAsAlias: z.boolean().optional(),
    smtpMsa: z
        .object({
            host: z.string().optional(),
            port: z.number().optional(),
            username: z.string().optional(),
            password: z.string().optional(),
            securityMode: z.string().optional()
        })
        .optional()
});

const sync = createSync({
    description: 'Sync Gmail send-as aliases and settings for Relayfile.',
    version: '1.0.0',
    frequency: 'every 6 hours',
    autoStart: true,
    endpoints: [
        {
            method: 'GET',
            path: '/gmail/send-as-aliases',
            group: 'Google Mail'
        }
    ],
    models: {
        GoogleMailSendAsAlias
    },
    scopes: ['https://www.googleapis.com/auth/gmail.settings.basic'],

    exec: async (nango) => {
        const response = await nango.get({
            // https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings.sendAs/list
            endpoint: '/gmail/v1/users/me/settings/sendAs',
            retries: 3
        });

        const parsed = ProviderResponseSchema.safeParse(response.data);
        if (!parsed.success) {
            throw new Error(`Invalid response from Gmail API: ${parsed.error.message}`);
        }

        const sendAsList = parsed.data.sendAs;
        const aliases: z.infer<typeof GoogleMailSendAsAlias>[] = [];

        for (const item of sendAsList) {
            const parsedItem = SendAsItemSchema.safeParse(item);
            if (!parsedItem.success) {
                continue;
            }
            const raw = parsedItem.data;

            aliases.push({
                id: raw.sendAsEmail,
                sendAsEmail: raw.sendAsEmail,
                ...(raw.displayName !== undefined && { displayName: raw.displayName }),
                ...(raw.replyToAddress !== undefined && { replyToAddress: raw.replyToAddress }),
                ...(raw.signature !== undefined && { signature: raw.signature }),
                ...(raw.isPrimary !== undefined && { isPrimary: raw.isPrimary }),
                ...(raw.isDefault !== undefined && { isDefault: raw.isDefault }),
                ...(raw.verificationStatus !== undefined && { verificationStatus: raw.verificationStatus }),
                ...(raw.treatAsAlias !== undefined && { treatAsAlias: raw.treatAsAlias }),
                ...(raw.smtpMsa !== undefined && {
                    smtpMsa: {
                        ...(raw.smtpMsa.host !== undefined && { host: raw.smtpMsa.host }),
                        ...(raw.smtpMsa.port !== undefined && { port: raw.smtpMsa.port }),
                        ...(raw.smtpMsa.username !== undefined && { username: raw.smtpMsa.username }),
                        ...(raw.smtpMsa.password !== undefined && { password: raw.smtpMsa.password }),
                        ...(raw.smtpMsa.securityMode !== undefined && { securityMode: raw.smtpMsa.securityMode })
                    }
                })
            });
        }

        await nango.trackDeletesStart('GoogleMailSendAsAlias');
        try {
            if (aliases.length > 0) {
                await nango.batchSave(aliases, 'GoogleMailSendAsAlias');
            }
        } finally {
            await nango.trackDeletesEnd('GoogleMailSendAsAlias');
        }
    }
});

export default sync;
