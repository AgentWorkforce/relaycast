#!/usr/bin/env node

/**
 * Seed HubSpot CRM test data through Nango's proxy endpoint.
 *
 * Usage:
 *   node scripts/seed-hubspot-test-data.mjs
 *
 * Required env:
 *   NANGO_SECRET_KEY (or NANGO_SECRET_KEY_PRODUCTION)
 */

const PROVIDER_CONFIG_KEY = process.env.HUBSPOT_PROVIDER_CONFIG_KEY || 'hubspot-relay';
const CONNECTION_ID = process.env.HUBSPOT_CONNECTION_ID || '';
const NANGO_API_URL = process.env.NANGO_API_URL || 'https://api.nango.dev';
const REQUEST_RETRIES = 3;
const OBJECT_COUNT = Number.parseInt(process.env.HUBSPOT_SEED_COUNT || '15', 10);

const SECRET_KEY = process.env.NANGO_SECRET_KEY || process.env.NANGO_SECRET_KEY_PRODUCTION;

if (!SECRET_KEY) {
    console.error('Missing NANGO_SECRET_KEY (or NANGO_SECRET_KEY_PRODUCTION) in environment.');
    process.exit(1);
}
if (!CONNECTION_ID) {
    console.error('Missing HUBSPOT_CONNECTION_ID in environment.');
    process.exit(1);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function proxyRequest({ method, endpoint, body }) {
    const url = `${NANGO_API_URL}/proxy${endpoint}`;
    let lastError = null;

    for (let attempt = 1; attempt <= REQUEST_RETRIES; attempt++) {
        const response = await fetch(url, {
            method,
            headers: {
                Authorization: `Bearer ${SECRET_KEY}`,
                'Content-Type': 'application/json',
                'Provider-Config-Key': PROVIDER_CONFIG_KEY,
                'Connection-Id': CONNECTION_ID,
                Retries: '2'
            },
            body: body ? JSON.stringify(body) : undefined
        });

        if (response.ok) {
            const text = await response.text();
            return text ? JSON.parse(text) : {};
        }

        const errorText = await response.text();
        lastError = new Error(`HTTP ${response.status} ${method} ${endpoint}: ${errorText}`);

        if (response.status !== 429 && response.status < 500) {
            break;
        }

        await sleep(500 * attempt);
    }

    throw lastError;
}

async function getFirstPipelineStage(objectType) {
    const data = await proxyRequest({
        method: 'GET',
        endpoint: `/crm/v3/pipelines/${objectType}`
    });

    const pipelines = Array.isArray(data.results) ? data.results : [];
    const activePipeline = pipelines.find((pipeline) => !pipeline.archived) || pipelines[0];
    const stages = Array.isArray(activePipeline?.stages) ? activePipeline.stages : [];
    const activeStage = stages.find((stage) => !stage.archived) || stages[0];

    if (!activePipeline?.id || !activeStage?.id) {
        throw new Error(`Unable to resolve active pipeline + stage for ${objectType}`);
    }

    return {
        pipelineId: String(activePipeline.id),
        stageId: String(activeStage.id)
    };
}

function isoFuture(days) {
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

async function seed() {
    const runId = `${Date.now()}`;
    const summary = {
        companies: 0,
        contacts: 0,
        deals: 0,
        products: 0,
        orders: 0,
        tickets: 0
    };

    const [dealPipeline, ticketPipeline, orderPipeline] = await Promise.all([
        getFirstPipelineStage('deals'),
        getFirstPipelineStage('tickets'),
        getFirstPipelineStage('orders')
    ]);

    for (let i = 0; i < OBJECT_COUNT; i++) {
        const suffix = `${runId}-${i}`;

        await proxyRequest({
            method: 'POST',
            endpoint: '/crm/v3/objects/companies',
            body: {
                properties: {
                    name: `Relayfile Seed Company ${suffix}`,
                    domain: `relayfile-seed-${suffix}.example.com`
                }
            }
        });
        summary.companies++;

        await proxyRequest({
            method: 'POST',
            endpoint: '/crm/v3/objects/contacts',
            body: {
                properties: {
                    firstname: 'Relayfile',
                    lastname: `Seed ${i}`,
                    email: `relayfile-seed-${suffix}@example.com`,
                    company: `Relayfile Seed Company ${suffix}`
                }
            }
        });
        summary.contacts++;

        await proxyRequest({
            method: 'POST',
            endpoint: '/crm/v3/objects/products',
            body: {
                properties: {
                    name: `Relayfile Seed Product ${suffix}`,
                    description: 'Seeded via Nango proxy',
                    hs_sku: `RF-SKU-${suffix}`,
                    price: `${100 + i}`
                }
            }
        });
        summary.products++;

        await proxyRequest({
            method: 'POST',
            endpoint: '/crm/v3/objects/deals',
            body: {
                properties: {
                    dealname: `Relayfile Seed Deal ${suffix}`,
                    pipeline: dealPipeline.pipelineId,
                    dealstage: dealPipeline.stageId,
                    amount: `${500 + i}`,
                    closedate: isoFuture(14)
                }
            }
        });
        summary.deals++;

        await proxyRequest({
            method: 'POST',
            endpoint: '/crm/v3/objects/orders',
            body: {
                properties: {
                    hs_pipeline: orderPipeline.pipelineId,
                    hs_pipeline_stage: orderPipeline.stageId
                }
            }
        });
        summary.orders++;

        await proxyRequest({
            method: 'POST',
            endpoint: '/crm/v3/objects/tickets',
            body: {
                properties: {
                    hs_pipeline: ticketPipeline.pipelineId,
                    hs_pipeline_stage: ticketPipeline.stageId,
                    subject: `Relayfile Seed Ticket ${suffix}`,
                    hs_ticket_priority: i % 2 === 0 ? 'HIGH' : 'MEDIUM'
                }
            }
        });
        summary.tickets++;
    }

    console.log(
        JSON.stringify(
            {
                providerConfigKey: PROVIDER_CONFIG_KEY,
                connectionId: CONNECTION_ID,
                created: summary
            },
            null,
            2
        )
    );
}

seed().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
