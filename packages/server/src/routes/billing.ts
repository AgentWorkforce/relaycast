import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { requireOrgAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as orgEngine from '../engine/organization.js';

export const billingRoutes = new Hono<AppEnv>();

// POST /org/billing/checkout - create Stripe Checkout session
billingRoutes.post('/org/billing/checkout', requireOrgAuth, rateLimit, async (c) => {
  const stripeKey = c.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return c.json({ ok: false, error: { code: 'billing_not_configured', message: 'Stripe is not configured' } }, 503);
  }

  const org = c.get('organization');
  if (org.plan === 'pro' && org.subscriptionStatus === 'active') {
    return c.json({ ok: false, error: { code: 'already_subscribed', message: 'Organization already has an active subscription' } }, 409);
  }

  try {
    // Create Stripe Checkout Session via API
    const params = new URLSearchParams();
    params.set('mode', 'subscription');
    params.set('client_reference_id', org.id);
    params.set('success_url', 'https://relaycast.dev/dashboard/billing?success=true');
    params.set('cancel_url', 'https://relaycast.dev/dashboard/billing?canceled=true');
    params.set('line_items[0][price]', 'price_relaycast_pro'); // Stripe price ID to be configured
    params.set('line_items[0][quantity]', '1');

    if (org.stripeCustomerId) {
      params.set('customer', org.stripeCustomerId);
    }

    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!res.ok) {
      const body = await res.text();
      return c.json({ ok: false, error: { code: 'stripe_error', message: `Stripe error: ${body}` } }, 502);
    }

    const session = await res.json() as { url: string; id: string };
    return c.json({ ok: true, data: { checkout_url: session.url, session_id: session.id } });
  } catch (err: unknown) {
    const error = err as Error;
    return c.json({ ok: false, error: { code: 'internal_error', message: error.message } }, 500);
  }
});

// POST /org/billing/portal - create Stripe Customer Portal session
billingRoutes.post('/org/billing/portal', requireOrgAuth, rateLimit, async (c) => {
  const stripeKey = c.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return c.json({ ok: false, error: { code: 'billing_not_configured', message: 'Stripe is not configured' } }, 503);
  }

  const org = c.get('organization');
  if (!org.stripeCustomerId) {
    return c.json({ ok: false, error: { code: 'no_subscription', message: 'No Stripe customer found. Subscribe first.' } }, 400);
  }

  try {
    const params = new URLSearchParams();
    params.set('customer', org.stripeCustomerId);
    params.set('return_url', 'https://relaycast.dev/dashboard/billing');

    const res = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!res.ok) {
      const body = await res.text();
      return c.json({ ok: false, error: { code: 'stripe_error', message: `Stripe error: ${body}` } }, 502);
    }

    const session = await res.json() as { url: string };
    return c.json({ ok: true, data: { portal_url: session.url } });
  } catch (err: unknown) {
    const error = err as Error;
    return c.json({ ok: false, error: { code: 'internal_error', message: error.message } }, 500);
  }
});

// GET /org/billing - get billing status
billingRoutes.get('/org/billing', requireOrgAuth, rateLimit, async (c) => {
  const org = c.get('organization');
  return c.json({
    ok: true,
    data: {
      plan: org.plan,
      billing_source: org.billingSource,
      subscription_status: org.subscriptionStatus,
      stripe_customer_id: org.stripeCustomerId ?? null,
    },
  });
});
