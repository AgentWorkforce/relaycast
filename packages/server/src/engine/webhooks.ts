import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { workspaces } from '../db/schema.js';
import { resetUsageCounters } from './usage.js';

export interface WebhookEvent {
  type: string;
  data: Record<string, unknown>;
}

export async function handleSubscriptionUpdated(data: Record<string, unknown>): Promise<void> {
  const workspaceId = (data.metadata as Record<string, string>)?.workspace_id;
  if (!workspaceId) return;
  const plan = (data.metadata as Record<string, string>)?.plan;
  const db = getDb();
  await db.update(workspaces).set({
    plan: plan || 'free',
    stripeSubscriptionId: data.id as string,
  }).where(eq(workspaces.id, workspaceId));
}

export async function handleSubscriptionDeleted(data: Record<string, unknown>): Promise<void> {
  const workspaceId = (data.metadata as Record<string, string>)?.workspace_id;
  if (!workspaceId) return;
  const db = getDb();
  await db.update(workspaces).set({
    plan: 'free',
    stripeSubscriptionId: null,
  }).where(eq(workspaces.id, workspaceId));
}

export async function handleInvoicePaid(data: Record<string, unknown>): Promise<void> {
  const customerId = data.customer as string;
  if (!customerId) return;
  const db = getDb();
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.stripeCustomerId, customerId));
  if (!ws) return;
  // Reset usage counters for the new billing period
  await resetUsageCounters(ws.id);
}

export async function handlePaymentFailed(data: Record<string, unknown>): Promise<void> {
  const customerId = data.customer as string;
  if (!customerId) return;
  const db = getDb();
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.stripeCustomerId, customerId));
  if (!ws) return;
  // Downgrade workspace to free plan and clear stale subscription ID
  await db.update(workspaces).set({
    plan: 'free',
    stripeSubscriptionId: null,
  }).where(eq(workspaces.id, ws.id));
}

export async function processWebhook(event: WebhookEvent): Promise<{ received: boolean }> {
  switch (event.type) {
    case 'subscription.updated':
      await handleSubscriptionUpdated(event.data);
      break;
    case 'subscription.deleted':
      await handleSubscriptionDeleted(event.data);
      break;
    case 'invoice.paid':
      await handleInvoicePaid(event.data);
      break;
    case 'invoice.payment_failed':
      await handlePaymentFailed(event.data);
      break;
    default:
      // Unknown event type - acknowledge but do nothing
      break;
  }
  return { received: true };
}
