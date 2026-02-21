import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { getDb } from '../db/index.js';
import * as orgEngine from '../engine/organization.js';
import { organizations } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { createLogger, toErrorDetails } from '../lib/logger.js';

export const stripeWebhookRoutes = new Hono<AppEnv>();

async function verifyStripeSignature(
  body: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  const parts = signature.split(',');
  const timestamp = parts.find((p) => p.startsWith('t='))?.slice(2);
  const v1 = parts.find((p) => p.startsWith('v1='))?.slice(3);

  if (!timestamp || !v1) return false;

  const payload = `${timestamp}.${body}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Timing-safe comparison
  if (expected.length !== v1.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  }
  return mismatch === 0;
}

interface StripeEvent {
  type: string;
  data: {
    object: Record<string, unknown>;
  };
}

// POST /webhooks/stripe
stripeWebhookRoutes.post('/webhooks/stripe', async (c) => {
  const webhookSecret = c.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return c.text('Webhook secret not configured', 503);
  }

  const signature = c.req.header('Stripe-Signature');
  if (!signature) {
    return c.text('Missing Stripe-Signature header', 400);
  }

  const body = await c.req.text();
  const valid = await verifyStripeSignature(body, signature, webhookSecret);
  if (!valid) {
    return c.text('Invalid signature', 401);
  }

  const event: StripeEvent = JSON.parse(body);
  const db = getDb(c.env.DB);
  const logger = createLogger(c.env, { source: 'stripe_webhook' });

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as {
          client_reference_id?: string;
          customer?: string;
          subscription?: string;
        };
        const orgId = session.client_reference_id;
        if (orgId) {
          await orgEngine.setOrgPlan(db, orgId, {
            plan: 'pro',
            billing_source: 'stripe',
            stripe_customer_id: (session.customer as string) ?? null,
            subscription_status: 'active',
          });
          logger.info('Org upgraded to pro via Stripe checkout', { org_id: orgId });
        }
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object as { customer?: string };
        if (invoice.customer) {
          const [org] = await db
            .select()
            .from(organizations)
            .where(eq(organizations.stripeCustomerId, invoice.customer as string));
          if (org) {
            await orgEngine.setOrgPlan(db, org.id, {
              plan: 'pro',
              subscription_status: 'active',
            });
          }
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as { customer?: string };
        if (invoice.customer) {
          const [org] = await db
            .select()
            .from(organizations)
            .where(eq(organizations.stripeCustomerId, invoice.customer as string));
          if (org) {
            await orgEngine.setOrgPlan(db, org.id, {
              plan: org.plan,
              subscription_status: 'past_due',
            });
            logger.warn('Payment failed for org', { org_id: org.id });
          }
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as { customer?: string };
        if (subscription.customer) {
          const [org] = await db
            .select()
            .from(organizations)
            .where(eq(organizations.stripeCustomerId, subscription.customer as string));
          if (org) {
            await orgEngine.setOrgPlan(db, org.id, {
              plan: 'free',
              subscription_status: 'canceled',
            });
            logger.info('Org downgraded to free via subscription cancellation', { org_id: org.id });
          }
        }
        break;
      }
    }
  } catch (err) {
    logger.error('Stripe webhook handler error', {
      event_type: event.type,
      ...toErrorDetails(err),
    });
  }

  await logger.flush();
  return c.text('ok', 200);
});
