export type NangoWebhookSetupClient = {
    ActionError: new (input: { type: string; message: string }) => Error;
    getIntegration: (queries?: { include?: Array<'webhook' | 'credentials'> }) => Promise<unknown>;
    getWebhookURL: () => Promise<string | null | undefined>;
    log: (message: string, options?: { level?: 'debug' | 'info' | 'warn' | 'error' }) => void | Promise<void>;
};

export type NangoWebhookConfig = {
    url: string;
    secret?: string;
};

export async function getRequiredNangoWebhookConfig(nango: NangoWebhookSetupClient): Promise<NangoWebhookConfig> {
    const integration = await getIntegrationWithWebhook(nango);
    const webhookUrl = readString(integration, 'webhook_url') ?? readString(integration, 'webhookUrl') ?? await nango.getWebhookURL();
    const secret = readString(integration, 'webhookSecret') ?? readString(integration, 'webhook_secret');

    if (!webhookUrl) {
        throw new nango.ActionError({
            type: 'missing_nango_webhook_url',
            message: 'Nango did not return a webhook URL for this integration. Configure external webhooks before setup.'
        });
    }

    return {
        url: webhookUrl,
        ...(secret ? { secret } : {})
    };
}

export function missingEvents(existingEvents: readonly string[], requiredEvents: readonly string[]): string[] {
    const existing = new Set(existingEvents);
    return requiredEvents.filter((event) => !existing.has(event));
}

export function hasEventOverlap(existingEvents: readonly string[], requiredEvents: readonly string[]): boolean {
    const required = new Set(requiredEvents);
    return existingEvents.some((event) => required.has(event));
}

export function sameWebhookUrl(left: unknown, right: string): boolean {
    return typeof left === 'string' && normalizeUrl(left) === normalizeUrl(right);
}

export function splitRepositoryFullName(fullName: string): { owner: string; repo: string } | null {
    const [owner, repo, ...rest] = fullName.split('/');
    if (!owner || !repo || rest.length > 0) {
        return null;
    }

    return { owner, repo };
}

async function getIntegrationWithWebhook(nango: NangoWebhookSetupClient): Promise<Record<string, unknown> | null> {
    try {
        const integration = await nango.getIntegration({ include: ['webhook'] });
        return isRecord(integration) ? integration : null;
    } catch (error) {
        await nango.log(`Failed to read Nango integration webhook config; falling back to getWebhookURL(): ${formatError(error)}`, {
            level: 'warn'
        });
        return null;
    }
}

function readString(record: Record<string, unknown> | null, key: string): string | undefined {
    const value = record?.[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeUrl(value: string): string {
    return value.replace(/\/+$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
