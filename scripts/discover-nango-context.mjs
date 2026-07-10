#!/usr/bin/env node

/**
 * Discover integrations + connections from a Nango environment and emit
 * candidate providerConfigKey/connectionId pairs for dryrun usage.
 *
 * Usage:
 *   node scripts/discover-nango-context.mjs
 *   node scripts/discover-nango-context.mjs --connection-id my-user
 *   node scripts/discover-nango-context.mjs --provider-config-key slack-prod
 *
 * Required env:
 *   NANGO_SECRET_KEY
 * Optional env:
 *   NANGO_HOST (default: https://api.nango.dev)
 */

const args = process.argv.slice(2);

function readArg(name) {
    const index = args.indexOf(name);
    if (index === -1) return undefined;
    const value = args[index + 1];
    return value && !value.startsWith('--') ? value : undefined;
}

const connectionIdFilter = readArg('--connection-id');
const providerConfigKeyFilter = readArg('--provider-config-key');
const host = process.env.NANGO_HOST || 'https://api.nango.dev';
const secretKey = process.env.NANGO_SECRET_KEY;
const parsedTimeout = Number.parseInt(process.env.NANGO_REQUEST_TIMEOUT_MS || '15000', 10);
const REQUEST_TIMEOUT_MS = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 15000;
const CONNECTION_PAGE_SIZE = 200;

if (!secretKey) {
    console.error('Missing NANGO_SECRET_KEY in environment.');
    process.exit(1);
}

function normalizeBaseUrl(url) {
    return url.endsWith('/') ? url.slice(0, -1) : url;
}

const baseUrl = normalizeBaseUrl(host);

async function requestJson(pathWithQuery) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;

    try {
        response = await fetch(`${baseUrl}${pathWithQuery}`, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${secretKey}`,
                'Content-Type': 'application/json'
            },
            signal: controller.signal
        });
    } catch (error) {
        if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') {
            throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms for ${pathWithQuery}`);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`HTTP ${response.status} for ${pathWithQuery}: ${body}`);
    }

    return response.json();
}

async function listIntegrations() {
    // New HTTP API first, old node-client-compatible endpoint as fallback.
    try {
        const body = await requestJson('/integrations');
        const rows = Array.isArray(body?.data) ? body.data : [];
        return rows.map((item) => ({
            unique_key: item.unique_key,
            provider: item.provider
        }));
    } catch (_error) {
        const body = await requestJson('/config');
        const rows = Array.isArray(body?.configs) ? body.configs : [];
        return rows.map((item) => ({
            unique_key: item.unique_key,
            provider: item.provider
        }));
    }
}

async function listConnections() {
    const listFrom = async (endpoint) => {
        const output = [];
        for (let page = 0; ; page++) {
            const params = new URLSearchParams();
            if (connectionIdFilter) params.set('connectionId', connectionIdFilter);
            params.set('limit', String(CONNECTION_PAGE_SIZE));
            params.set('page', String(page));

            const body = await requestJson(`${endpoint}?${params.toString()}`);
            const rows = Array.isArray(body?.connections) ? body.connections : [];
            output.push(...rows);

            if (rows.length < CONNECTION_PAGE_SIZE) break;
        }
        return output;
    };

    // New HTTP API first, deprecated endpoint as fallback.
    try {
        return await listFrom('/connections');
    } catch (_error) {
        return await listFrom('/connection');
    }
}

function dedupeByKey(rows, keyFn) {
    const seen = new Set();
    const output = [];
    for (const row of rows) {
        const key = keyFn(row);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        output.push(row);
    }
    return output;
}

function main() {
    return Promise.all([listIntegrations(), listConnections()]).then(([integrationsRaw, connectionsRaw]) => {
        let integrations = dedupeByKey(integrationsRaw, (item) => item.unique_key)
            .filter((item) => item.unique_key && item.provider);

        let connections = connectionsRaw
            .map((item) => ({
                connection_id: item.connection_id,
                provider_config_key: item.provider_config_key,
                provider: item.provider,
                created: item.created
            }))
            .filter((item) => item.connection_id && item.provider_config_key);

        if (providerConfigKeyFilter) {
            integrations = integrations.filter((item) => item.unique_key === providerConfigKeyFilter);
            connections = connections.filter((item) => item.provider_config_key === providerConfigKeyFilter);
        }

        const integrationMap = new Map(integrations.map((item) => [item.unique_key, item]));
        const suggestedPairs = connections
            .filter((item) => integrationMap.has(item.provider_config_key))
            .map((item) => ({
                provider_config_key: item.provider_config_key,
                provider: integrationMap.get(item.provider_config_key)?.provider ?? item.provider ?? null,
                connection_id: item.connection_id,
                created: item.created ?? null
            }));

        const payload = {
            host: baseUrl,
            filters: {
                connection_id: connectionIdFilter ?? null,
                provider_config_key: providerConfigKeyFilter ?? null
            },
            counts: {
                integrations: integrations.length,
                connections: connections.length,
                suggested_pairs: suggestedPairs.length
            },
            integrations,
            connections,
            suggested_pairs: suggestedPairs
        };

        console.log(JSON.stringify(payload, null, 2));
    });
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
