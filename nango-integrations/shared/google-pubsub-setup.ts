import { createSign } from 'crypto';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type GooglePubSubSetupClient = {
    ActionError: new (input: { type: string; message: string }) => Error;
    log: (message: string, options?: { level?: LogLevel }) => void | Promise<void>;
};

type GoogleServiceAccountConfig = {
    projectId?: string;
    clientEmail: string;
    privateKey: string;
};

type ParsedTopicName = {
    topicName: string;
    projectId: string;
    topicId: string;
};

type ParsedSubscriptionName = {
    subscriptionName: string;
    projectId: string;
    subscriptionId: string;
};

export type PubSubAutoProvisionInput = {
    nango: GooglePubSubSetupClient;
    connectionId: string;
    webhookUrl: string;
    topicName?: string;
    metadata?: Record<string, unknown>;
    connectionConfig?: Record<string, unknown>;
    envMap?: Map<string, string>;
};

export type PubSubAutoProvisionResult = {
    topicName: string;
    subscriptionName?: string;
    autoProvisionAttempted: boolean;
    autoProvisionApplied: boolean;
};

const PUBSUB_API_BASE_URL = 'https://pubsub.googleapis.com/v1';
const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PUBSUB_SCOPE = 'https://www.googleapis.com/auth/pubsub';
const GMAIL_PUSH_SERVICE_ACCOUNT = 'gmail-api-push@system.gserviceaccount.com';

const TOPIC_NAME_ENV_KEYS = ['GOOGLE_MAIL_WATCH_TOPIC_NAME', 'GMAIL_WATCH_TOPIC_NAME'] as const;
const PUBSUB_PROJECT_ID_ENV_KEYS = ['GOOGLE_MAIL_PUBSUB_PROJECT_ID', 'GMAIL_PUBSUB_PROJECT_ID'] as const;
const PUBSUB_TOPIC_ID_ENV_KEYS = ['GOOGLE_MAIL_PUBSUB_TOPIC_ID', 'GMAIL_PUBSUB_TOPIC_ID'] as const;
const PUBSUB_TOPIC_NAME_ENV_KEYS = ['GOOGLE_MAIL_PUBSUB_TOPIC_NAME', 'GMAIL_PUBSUB_TOPIC_NAME'] as const;
const PUBSUB_SUBSCRIPTION_ID_ENV_KEYS = ['GOOGLE_MAIL_PUBSUB_SUBSCRIPTION_ID', 'GMAIL_PUBSUB_SUBSCRIPTION_ID'] as const;
const PUBSUB_PUSH_AUDIENCE_ENV_KEYS = ['GOOGLE_MAIL_PUBSUB_PUSH_AUDIENCE', 'GMAIL_PUBSUB_PUSH_AUDIENCE'] as const;
const PUBSUB_PUSH_AUTH_SA_ENV_KEYS = [
    'GOOGLE_MAIL_PUBSUB_PUSH_AUTH_SERVICE_ACCOUNT_EMAIL',
    'GMAIL_PUBSUB_PUSH_AUTH_SERVICE_ACCOUNT_EMAIL'
] as const;
const PUBSUB_AUTO_PROVISION_ENV_KEYS = ['GOOGLE_MAIL_PUBSUB_AUTO_PROVISION', 'GMAIL_PUBSUB_AUTO_PROVISION'] as const;
const PUBSUB_SERVICE_ACCOUNT_JSON_ENV_KEYS = [
    'GOOGLE_MAIL_PUBSUB_SERVICE_ACCOUNT_JSON',
    'GMAIL_PUBSUB_SERVICE_ACCOUNT_JSON'
] as const;
const PUBSUB_SERVICE_ACCOUNT_EMAIL_ENV_KEYS = [
    'GOOGLE_MAIL_PUBSUB_SERVICE_ACCOUNT_EMAIL',
    'GMAIL_PUBSUB_SERVICE_ACCOUNT_EMAIL'
] as const;
const PUBSUB_SERVICE_ACCOUNT_PRIVATE_KEY_ENV_KEYS = [
    'GOOGLE_MAIL_PUBSUB_SERVICE_ACCOUNT_PRIVATE_KEY',
    'GMAIL_PUBSUB_SERVICE_ACCOUNT_PRIVATE_KEY'
] as const;

export async function ensureGooglePubSubInfrastructure(input: PubSubAutoProvisionInput): Promise<PubSubAutoProvisionResult> {
    const metadata = input.metadata ?? {};
    const connectionConfig = input.connectionConfig ?? {};
    const envMap = input.envMap ?? new Map<string, string>();

    const autoProvisionEnabled = resolveAutoProvisionEnabled(metadata, connectionConfig, envMap);
    const resolvedTopicName = resolveTopicName(input.topicName, metadata, connectionConfig, envMap);

    if (!resolvedTopicName) {
        throw new input.nango.ActionError({
            type: 'missing_gmail_watch_topic_name',
            message:
                'Missing Gmail watch topic name. Set metadata.topicName (or metadata.pubsubTopicName), connection_config.topicName, or env GOOGLE_MAIL_WATCH_TOPIC_NAME.'
        });
    }

    const parsedTopic = parseTopicName(resolvedTopicName);
    const subscriptionName = resolveSubscriptionName({
        connectionId: input.connectionId,
        topicProjectId: parsedTopic.projectId,
        metadata,
        connectionConfig,
        envMap
    });

    if (!autoProvisionEnabled) {
        return {
            topicName: parsedTopic.topicName,
            subscriptionName,
            autoProvisionAttempted: false,
            autoProvisionApplied: false
        };
    }

    const serviceAccount = resolveServiceAccountConfig(metadata, connectionConfig, envMap);
    if (!serviceAccount) {
        await input.nango.log(
            'Skipping Pub/Sub auto-provisioning because service account credentials are not configured. Continuing with the provided topic name.',
            { level: 'warn' }
        );

        return {
            topicName: parsedTopic.topicName,
            subscriptionName,
            autoProvisionAttempted: true,
            autoProvisionApplied: false
        };
    }

    const pushConfig = resolvePushConfig(metadata, connectionConfig, envMap, input.webhookUrl);
    const accessToken = await mintServiceAccountAccessToken(serviceAccount);

    await ensureTopic({ topicName: parsedTopic.topicName, accessToken });
    await ensureGmailPublisherBinding({ topicName: parsedTopic.topicName, accessToken });
    await ensurePushSubscription({
        subscriptionName,
        topicName: parsedTopic.topicName,
        webhookUrl: input.webhookUrl,
        accessToken,
        ...(pushConfig.pushAuthServiceAccountEmail ? { pushAuthServiceAccountEmail: pushConfig.pushAuthServiceAccountEmail } : {}),
        ...(pushConfig.pushAudience ? { pushAudience: pushConfig.pushAudience } : {})
    });

    await input.nango.log(`Pub/Sub auto-provisioning complete for topic ${parsedTopic.topicName} and subscription ${subscriptionName}.`);

    return {
        topicName: parsedTopic.topicName,
        subscriptionName,
        autoProvisionAttempted: true,
        autoProvisionApplied: true
    };
}

function resolveAutoProvisionEnabled(metadata: Record<string, unknown>, connectionConfig: Record<string, unknown>, envMap: Map<string, string>): boolean {
    const raw =
        readBoolean(metadata['pubsubAutoProvision']) ??
        readBoolean(metadata['gmailPubsubAutoProvision']) ??
        readBoolean(connectionConfig['pubsubAutoProvision']) ??
        readBoolean(connectionConfig['gmailPubsubAutoProvision']) ??
        parseBoolean(readEnvValue(envMap, PUBSUB_AUTO_PROVISION_ENV_KEYS));

    return raw ?? true;
}

function resolveTopicName(
    inputTopicName: string | undefined,
    metadata: Record<string, unknown>,
    connectionConfig: Record<string, unknown>,
    envMap: Map<string, string>
): string | undefined {
    const directTopicName =
        inputTopicName ||
        readString(metadata['pubsubTopicName']) ||
        readString(metadata['gmailPubsubTopicName']) ||
        readString(connectionConfig['pubsubTopicName']) ||
        readString(connectionConfig['gmailPubsubTopicName']) ||
        readEnvValue(envMap, PUBSUB_TOPIC_NAME_ENV_KEYS) ||
        readEnvValue(envMap, TOPIC_NAME_ENV_KEYS);

    if (directTopicName) {
        return directTopicName;
    }

    const projectId =
        readString(metadata['pubsubProjectId']) ||
        readString(metadata['gmailPubsubProjectId']) ||
        readString(connectionConfig['pubsubProjectId']) ||
        readString(connectionConfig['gmailPubsubProjectId']) ||
        readEnvValue(envMap, PUBSUB_PROJECT_ID_ENV_KEYS);

    const topicId =
        readString(metadata['pubsubTopicId']) ||
        readString(metadata['gmailPubsubTopicId']) ||
        readString(connectionConfig['pubsubTopicId']) ||
        readString(connectionConfig['gmailPubsubTopicId']) ||
        readEnvValue(envMap, PUBSUB_TOPIC_ID_ENV_KEYS);

    if (projectId && topicId) {
        return `projects/${projectId}/topics/${topicId}`;
    }

    return undefined;
}

function resolveSubscriptionName(input: {
    connectionId: string;
    topicProjectId: string;
    metadata: Record<string, unknown>;
    connectionConfig: Record<string, unknown>;
    envMap: Map<string, string>;
}): string {
    const configured =
        readString(input.metadata['pubsubSubscriptionName']) ||
        readString(input.metadata['gmailPubsubSubscriptionName']) ||
        readString(input.connectionConfig['pubsubSubscriptionName']) ||
        readString(input.connectionConfig['gmailPubsubSubscriptionName']) ||
        readString(input.metadata['pubsubSubscriptionId']) ||
        readString(input.metadata['gmailPubsubSubscriptionId']) ||
        readString(input.connectionConfig['pubsubSubscriptionId']) ||
        readString(input.connectionConfig['gmailPubsubSubscriptionId']) ||
        readEnvValue(input.envMap, PUBSUB_SUBSCRIPTION_ID_ENV_KEYS);

    if (configured?.startsWith('projects/')) {
        const parsed = parseSubscriptionName(configured);
        return parsed.subscriptionName;
    }

    const subscriptionId = configured || `nango-gmail-${sanitizeResourceId(input.connectionId)}`;
    return `projects/${input.topicProjectId}/subscriptions/${subscriptionId}`;
}

function resolvePushConfig(metadata: Record<string, unknown>, connectionConfig: Record<string, unknown>, envMap: Map<string, string>, webhookUrl: string) {
    const pushAudience =
        readString(metadata['pubsubPushAudience']) ||
        readString(metadata['gmailPubsubPushAudience']) ||
        readString(connectionConfig['pubsubPushAudience']) ||
        readString(connectionConfig['gmailPubsubPushAudience']) ||
        readEnvValue(envMap, PUBSUB_PUSH_AUDIENCE_ENV_KEYS);

    const pushAuthServiceAccountEmail =
        readString(metadata['pubsubPushAuthServiceAccountEmail']) ||
        readString(metadata['gmailPubsubPushAuthServiceAccountEmail']) ||
        readString(connectionConfig['pubsubPushAuthServiceAccountEmail']) ||
        readString(connectionConfig['gmailPubsubPushAuthServiceAccountEmail']) ||
        readEnvValue(envMap, PUBSUB_PUSH_AUTH_SA_ENV_KEYS);

    return {
        webhookUrl,
        pushAudience,
        pushAuthServiceAccountEmail
    };
}

function resolveServiceAccountConfig(
    metadata: Record<string, unknown>,
    connectionConfig: Record<string, unknown>,
    envMap: Map<string, string>
): GoogleServiceAccountConfig | null {
    const rawServiceAccountJson =
        readString(metadata['pubsubServiceAccountJson']) ||
        readString(metadata['gmailPubsubServiceAccountJson']) ||
        readString(connectionConfig['pubsubServiceAccountJson']) ||
        readString(connectionConfig['gmailPubsubServiceAccountJson']) ||
        readEnvValue(envMap, PUBSUB_SERVICE_ACCOUNT_JSON_ENV_KEYS);

    if (rawServiceAccountJson) {
        try {
            const parsed = JSON.parse(rawServiceAccountJson) as Record<string, unknown>;
            const projectId = readString(parsed['project_id']) || readString(parsed['projectId']);
            const clientEmail = readString(parsed['client_email']) || readString(parsed['clientEmail']);
            const privateKey = decodePrivateKey(readString(parsed['private_key']) || readString(parsed['privateKey']));

            if (clientEmail && privateKey) {
                return {
                    ...(projectId ? { projectId } : {}),
                    clientEmail,
                    privateKey
                };
            }
        } catch {
            return null;
        }
    }

    const clientEmail =
        readString(metadata['pubsubServiceAccountEmail']) ||
        readString(metadata['gmailPubsubServiceAccountEmail']) ||
        readString(connectionConfig['pubsubServiceAccountEmail']) ||
        readString(connectionConfig['gmailPubsubServiceAccountEmail']) ||
        readEnvValue(envMap, PUBSUB_SERVICE_ACCOUNT_EMAIL_ENV_KEYS);

    const privateKey = decodePrivateKey(
        readString(metadata['pubsubServiceAccountPrivateKey']) ||
            readString(metadata['gmailPubsubServiceAccountPrivateKey']) ||
            readString(connectionConfig['pubsubServiceAccountPrivateKey']) ||
            readString(connectionConfig['gmailPubsubServiceAccountPrivateKey']) ||
            readEnvValue(envMap, PUBSUB_SERVICE_ACCOUNT_PRIVATE_KEY_ENV_KEYS)
    );

    if (!clientEmail || !privateKey) {
        return null;
    }

    const projectId =
        readString(metadata['pubsubProjectId']) ||
        readString(metadata['gmailPubsubProjectId']) ||
        readString(connectionConfig['pubsubProjectId']) ||
        readString(connectionConfig['gmailPubsubProjectId']) ||
        readEnvValue(envMap, PUBSUB_PROJECT_ID_ENV_KEYS);

    return {
        ...(projectId ? { projectId } : {}),
        clientEmail,
        privateKey
    };
}

async function ensureTopic(input: { topicName: string; accessToken: string }): Promise<void> {
    await fetchGoogleJson({
        url: `${PUBSUB_API_BASE_URL}/${input.topicName}`,
        method: 'PUT',
        accessToken: input.accessToken,
        body: {}
    });
}

async function ensureGmailPublisherBinding(input: { topicName: string; accessToken: string }): Promise<void> {
    const getPolicyResponse = await fetchGoogleJson({
        url: `${PUBSUB_API_BASE_URL}/${input.topicName}:getIamPolicy`,
        method: 'POST',
        accessToken: input.accessToken,
        body: {}
    });
    const policy = asRecord(getPolicyResponse);
    const existingBindings = Array.isArray(policy?.['bindings']) ? policy['bindings'] : [];

    const hasPublisher = existingBindings.some((binding) => {
        const bindingRecord = asRecord(binding);
        const role = readString(bindingRecord?.['role']);
        if (role !== 'roles/pubsub.publisher') {
            return false;
        }

        const members = Array.isArray(bindingRecord?.['members']) ? bindingRecord['members'] : [];
        return members.includes(`serviceAccount:${GMAIL_PUSH_SERVICE_ACCOUNT}`);
    });

    if (hasPublisher) {
        return;
    }

    const updatedBindings = existingBindings.map((binding) => {
        const bindingRecord = asRecord(binding);
        if (!bindingRecord || readString(bindingRecord['role']) !== 'roles/pubsub.publisher') {
            return binding;
        }

        const members = Array.isArray(bindingRecord['members']) ? bindingRecord['members'].filter((entry) => typeof entry === 'string') : [];
        if (!members.includes(`serviceAccount:${GMAIL_PUSH_SERVICE_ACCOUNT}`)) {
            members.push(`serviceAccount:${GMAIL_PUSH_SERVICE_ACCOUNT}`);
        }

        return { ...bindingRecord, members };
    });

    if (!updatedBindings.some((binding) => asRecord(binding)?.['role'] === 'roles/pubsub.publisher')) {
        updatedBindings.push({
            role: 'roles/pubsub.publisher',
            members: [`serviceAccount:${GMAIL_PUSH_SERVICE_ACCOUNT}`]
        });
    }

    await fetchGoogleJson({
        url: `${PUBSUB_API_BASE_URL}/${input.topicName}:setIamPolicy`,
        method: 'POST',
        accessToken: input.accessToken,
        body: {
            policy: {
                ...(policy?.['etag'] ? { etag: policy['etag'] } : {}),
                bindings: updatedBindings
            }
        }
    });
}

async function ensurePushSubscription(input: {
    subscriptionName: string;
    topicName: string;
    webhookUrl: string;
    accessToken: string;
    pushAuthServiceAccountEmail?: string;
    pushAudience?: string;
}): Promise<void> {
    const pushConfig: Record<string, unknown> = {
        pushEndpoint: input.webhookUrl
    };

    if (input.pushAuthServiceAccountEmail) {
        pushConfig['oidcToken'] = {
            serviceAccountEmail: input.pushAuthServiceAccountEmail,
            ...(input.pushAudience ? { audience: input.pushAudience } : {})
        };
    }

    const subscriptionBody = {
        topic: input.topicName,
        pushConfig,
        ackDeadlineSeconds: 30
    };

    await fetchGoogleJson({
        url: `${PUBSUB_API_BASE_URL}/${input.subscriptionName}`,
        method: 'PUT',
        accessToken: input.accessToken,
        body: subscriptionBody
    });
}

async function mintServiceAccountAccessToken(serviceAccount: GoogleServiceAccountConfig): Promise<string> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const jwtPayload = {
        iss: serviceAccount.clientEmail,
        scope: PUBSUB_SCOPE,
        aud: GOOGLE_OAUTH_TOKEN_URL,
        iat: nowSeconds,
        exp: nowSeconds + 3600
    };

    const jwtHeader = {
        alg: 'RS256',
        typ: 'JWT'
    };

    const unsignedToken = `${base64UrlEncodeJson(jwtHeader)}.${base64UrlEncodeJson(jwtPayload)}`;
    const signer = createSign('RSA-SHA256');
    signer.update(unsignedToken);
    signer.end();

    const signature = signer.sign(serviceAccount.privateKey);
    const assertion = `${unsignedToken}.${base64UrlEncodeBuffer(signature)}`;

    const tokenResponse = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion
        }).toString()
    });

    const tokenBody = (await tokenResponse.json().catch(() => null)) as unknown;
    if (!tokenResponse.ok) {
        const bodyText = tokenBody ? JSON.stringify(tokenBody) : await tokenResponse.text().catch(() => 'unknown error');
        throw new Error(`Google OAuth token request failed (${tokenResponse.status}): ${bodyText}`);
    }

    const tokenRecord = asRecord(tokenBody);
    const accessToken = readString(tokenRecord?.['access_token']);
    if (!accessToken) {
        throw new Error('Google OAuth token response did not include access_token.');
    }

    return accessToken;
}

async function fetchGoogleJson(input: {
    url: string;
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    accessToken: string;
    body?: unknown;
}): Promise<unknown> {
    const response = await fetch(input.url, {
        method: input.method,
        headers: {
            Authorization: `Bearer ${input.accessToken}`,
            ...(input.body !== undefined ? { 'Content-Type': 'application/json' } : {})
        },
        ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {})
    });

    const responseJson = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
        const body = responseJson ? JSON.stringify(responseJson) : await response.text().catch(() => 'unknown error');
        throw new Error(`Google Pub/Sub API call failed (${response.status}) ${input.method} ${input.url}: ${body}`);
    }

    return responseJson;
}

function parseTopicName(topicName: string): ParsedTopicName {
    const match = /^projects\/([^/]+)\/topics\/([^/]+)$/.exec(topicName);
    if (!match || !match[1] || !match[2]) {
        throw new Error(`Invalid Pub/Sub topic name "${topicName}". Expected format "projects/{project}/topics/{topic}".`);
    }

    return {
        topicName,
        projectId: match[1],
        topicId: match[2]
    };
}

function parseSubscriptionName(subscriptionName: string): ParsedSubscriptionName {
    const match = /^projects\/([^/]+)\/subscriptions\/([^/]+)$/.exec(subscriptionName);
    if (!match || !match[1] || !match[2]) {
        throw new Error(
            `Invalid Pub/Sub subscription name "${subscriptionName}". Expected format "projects/{project}/subscriptions/{subscription}".`
        );
    }

    return {
        subscriptionName,
        projectId: match[1],
        subscriptionId: match[2]
    };
}

function sanitizeResourceId(value: string): string {
    const normalized = value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/--+/g, '-').replace(/^-+|-+$/g, '');
    return normalized.length > 0 ? normalized.slice(0, 255) : 'nango-google-mail';
}

function decodePrivateKey(value: string | undefined): string | undefined {
    if (!value) {
        return undefined;
    }

    return value.replace(/\\n/g, '\n');
}

function base64UrlEncodeJson(value: unknown): string {
    return base64UrlEncodeBuffer(Buffer.from(JSON.stringify(value), 'utf8'));
}

function base64UrlEncodeBuffer(value: Buffer): string {
    return value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function readEnvValue(envMap: Map<string, string>, keys: readonly string[]): string | undefined {
    for (const key of keys) {
        const value = envMap.get(key);
        if (value && value.length > 0) {
            return value;
        }
    }
    return undefined;
}

function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        return parseBoolean(value);
    }
    return undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
    if (!value) {
        return undefined;
    }

    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
        return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
        return false;
    }
    return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
