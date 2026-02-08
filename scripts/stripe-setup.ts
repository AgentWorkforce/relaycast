#!/usr/bin/env npx tsx
/**
 * Stripe Product & Price Setup Script
 *
 * Creates the Relaycast product and pricing tiers in your Stripe account.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_test_xxx npx tsx scripts/stripe-setup.ts
 *
 * This script is idempotent — it checks for existing products/prices before creating.
 */

import Stripe from 'stripe';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_SECRET_KEY) {
  console.error('Error: STRIPE_SECRET_KEY environment variable is required.');
  console.error('Usage: STRIPE_SECRET_KEY=sk_test_xxx npx tsx scripts/stripe-setup.ts');
  process.exit(1);
}

const stripe = new Stripe(STRIPE_SECRET_KEY);

interface PlanConfig {
  plan: string;
  name: string;
  amount: number; // in cents
  description: string;
  limits: {
    messages: number;
    agents: number;
    file_storage_gb: number;
    rate_per_min: number;
  };
}

const PLANS: PlanConfig[] = [
  {
    plan: 'free',
    name: 'Free',
    amount: 0,
    description: 'For trying out Relaycast — 10K messages, 5 agents',
    limits: { messages: 10_000, agents: 5, file_storage_gb: 0.1, rate_per_min: 60 },
  },
  {
    plan: 'pro',
    name: 'Pro',
    amount: 9900,
    description: 'For production workloads — 1M messages, 100 agents',
    limits: { messages: 1_000_000, agents: 100, file_storage_gb: 50, rate_per_min: 1200 },
  },
  {
    plan: 'enterprise',
    name: 'Enterprise',
    amount: 79900,
    description: 'Unlimited usage for large-scale deployments',
    limits: { messages: -1, agents: -1, file_storage_gb: 500, rate_per_min: 6000 },
  },
];

async function findExistingProduct(): Promise<Stripe.Product | null> {
  const products = await stripe.products.list({ limit: 100, active: true });
  return products.data.find((p) => p.name === 'Relaycast') || null;
}

async function findExistingPrice(
  productId: string,
  plan: string,
): Promise<Stripe.Price | null> {
  const prices = await stripe.prices.list({
    product: productId,
    limit: 100,
    active: true,
  });
  return prices.data.find((p) => p.metadata?.plan === plan) || null;
}

async function main() {
  console.log('Setting up Stripe products and prices for Relaycast...\n');

  // 1. Create or find the product
  let product = await findExistingProduct();
  if (product) {
    console.log(`Found existing product: ${product.id}`);
  } else {
    product = await stripe.products.create({
      name: 'Relaycast',
      description: 'Agent-to-agent messaging platform for AI teams',
      metadata: { managed_by: 'relaycast-setup' },
    });
    console.log(`Created product: ${product.id}`);
  }

  // 2. Create prices for each plan
  const results: Record<string, { price_id: string; amount: number }> = {};

  for (const planConfig of PLANS) {
    const existing = await findExistingPrice(product.id, planConfig.plan);
    if (existing) {
      console.log(`Found existing ${planConfig.name} price: ${existing.id}`);
      results[planConfig.plan] = {
        price_id: existing.id,
        amount: planConfig.amount,
      };
      continue;
    }

    const priceParams: Stripe.PriceCreateParams = {
      product: product.id,
      currency: 'usd',
      recurring: { interval: 'month' },
      metadata: {
        plan: planConfig.plan,
        managed_by: 'relaycast-setup',
      },
      nickname: `Relaycast ${planConfig.name}`,
    };

    if (planConfig.amount === 0) {
      // Stripe doesn't allow $0 prices with `unit_amount`, use custom pricing
      priceParams.unit_amount = 0;
      priceParams.billing_scheme = 'per_unit';
    } else {
      priceParams.unit_amount = planConfig.amount;
    }

    const price = await stripe.prices.create(priceParams);
    console.log(`Created ${planConfig.name} price: ${price.id} ($${planConfig.amount / 100}/mo)`);
    results[planConfig.plan] = {
      price_id: price.id,
      amount: planConfig.amount,
    };
  }

  // 3. Output summary
  console.log('\n=== Setup Complete ===\n');
  console.log(JSON.stringify(
    {
      product_id: product.id,
      prices: results,
    },
    null,
    2,
  ));

  console.log('\nAdd these to your environment:');
  console.log(`  STRIPE_PRODUCT_ID=${product.id}`);
  for (const [plan, info] of Object.entries(results)) {
    console.log(`  STRIPE_PRICE_${plan.toUpperCase()}=${info.price_id}`);
  }
}

main().catch((err) => {
  console.error('Stripe setup failed:', err.message);
  process.exit(1);
});
