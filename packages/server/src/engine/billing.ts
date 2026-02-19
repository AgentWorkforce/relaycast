import { eq } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { workspaces } from '../db/schema.js';
import { generateId } from './snowflake.js';

type Db = ReturnType<typeof getDb>;

export const PLAN_LIMITS: Record<string, { messages: number; agents: number; file_bytes: number; rate_per_min: number }> = {
  free: { messages: 10000, agents: 5, file_bytes: 100 * 1024 * 1024, rate_per_min: 60 },
  pro: { messages: 1000000, agents: 100, file_bytes: 50 * 1024 * 1024 * 1024, rate_per_min: 1200 },
  enterprise: { messages: Infinity, agents: Infinity, file_bytes: 500 * 1024 * 1024 * 1024, rate_per_min: 6000 },
};

type StripeSubscription = { id: string; customer: string; status: string; current_period_end: number; metadata: { plan: string; workspace_id: string } };
type StripeInvoice = { id: string; amount_paid: number; currency: string; status: string; period_start: number; period_end: number; invoice_pdf: string };

const subscriptionStore = new Map<string, StripeSubscription>();
const invoiceStore = new Map<string, StripeInvoice[]>();

function toUnix(d: Date) { return Math.floor(d.getTime() / 1000); }
function fromUnix(n: number) { return new Date(n * 1000).toISOString(); }
function monthBounds(now: Date) { return { start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) }; }
function prevMonthBounds(now: Date) { return { start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)), end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) }; }

async function readUsage(kv: KVNamespace, wid: string, period: 'current' | 'previous') {
  const pfx = period === 'current' ? `usage:${wid}:` : `usage:${wid}:previous:`;
  const keys = [`${pfx}messages`, `${pfx}api_calls`, `${pfx}files`, `${pfx}file_bytes`, `${pfx}ws_minutes`];
  const vals = await Promise.all(keys.map(k => kv.get(k)));
  const p = (v: string | null) => { const n = parseInt(v || '0', 10); return Number.isFinite(n) ? n : 0; };
  return { messages_sent: p(vals[0]), api_calls: p(vals[1]), files_uploaded: p(vals[2]), file_bytes: p(vals[3]), ws_minutes: p(vals[4]) };
}

export const stripe = {
  customers: { async create(_p: { name?: string; metadata?: Record<string, string> }) { return { id: `cus_${generateId()}` }; } },
  subscriptions: {
    async create(p: { customer: string; metadata: { plan: string; workspace_id: string }; default_payment_method: string }): Promise<StripeSubscription> {
      const sub: StripeSubscription = { id: `sub_${generateId()}`, customer: p.customer, status: 'active', current_period_end: toUnix(new Date(Date.now() + 30*24*60*60*1000)), metadata: p.metadata };
      subscriptionStore.set(sub.id, sub); return sub;
    },
    async retrieve(id: string): Promise<StripeSubscription> {
      const s = subscriptionStore.get(id); if (!s) { const e = new Error('Subscription not found'); Object.assign(e, { code: 'subscription_not_found', status: 404 }); throw e; } return s;
    },
  },
  invoices: {
    async list(p: { customer: string; limit: number }): Promise<{ data: StripeInvoice[] }> {
      let ex = invoiceStore.get(p.customer) || [];
      if (!ex.length) { const { start, end } = monthBounds(new Date()); ex = [{ id: `in_${generateId()}`, amount_paid: 0, currency: 'usd', status: 'open', period_start: toUnix(start), period_end: toUnix(end), invoice_pdf: `https://example.com/invoices/${generateId()}.pdf` }]; invoiceStore.set(p.customer, ex); }
      return { data: ex.slice(0, p.limit) };
    },
  },
  billingPortal: { sessions: { async create(p: { customer: string; return_url?: string }) { return { url: `https://billing.example.com/session/${generateId()}?customer=${p.customer}` }; } } },
};

export async function subscribe(db: Db, workspaceId: string, plan: string, paymentMethod: string) {
  if (plan !== 'pro' && plan !== 'enterprise') { const e = new Error("plan must be 'pro' or 'enterprise'"); Object.assign(e, { code: 'invalid_plan', status: 400 }); throw e; }
  if (!paymentMethod) { const e = new Error('payment_method is required'); Object.assign(e, { code: 'invalid_request', status: 400 }); throw e; }
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!ws) { const e = new Error('Workspace not found'); Object.assign(e, { code: 'workspace_not_found', status: 404 }); throw e; }
  let cid = ws.stripeCustomerId;
  if (!cid) { const c = await stripe.customers.create({ name: ws.name, metadata: { workspace_id: workspaceId } }); cid = c.id; }
  const sub = await stripe.subscriptions.create({ customer: cid, metadata: { plan, workspace_id: workspaceId }, default_payment_method: paymentMethod });
  await db.update(workspaces).set({ stripeCustomerId: cid, stripeSubscriptionId: sub.id, plan }).where(eq(workspaces.id, workspaceId));
  return { subscription_id: sub.id, plan, status: sub.status, current_period_end: fromUnix(sub.current_period_end) };
}

export async function getSubscription(kv: KVNamespace, workspaceId: string, plan: string, stripeSubId: string | null) {
  if (!stripeSubId) return { plan: 'free', status: 'active', current_period_end: null, usage_this_period: null };
  const sub = await stripe.subscriptions.retrieve(stripeSubId);
  const usage = await readUsage(kv, workspaceId, 'current');
  return { plan: sub.metadata.plan || plan, status: sub.status, current_period_end: fromUnix(sub.current_period_end), usage_this_period: usage };
}

export async function getUsage(kv: KVNamespace, workspaceId: string, period: string) {
  const p: 'current' | 'previous' = period === 'previous' ? 'previous' : 'current';
  const now = new Date();
  const bounds = p === 'current' ? monthBounds(now) : prevMonthBounds(now);
  const counters = await readUsage(kv, workspaceId, p);
  return { ...counters, period_start: bounds.start.toISOString(), period_end: bounds.end.toISOString() };
}

export async function getInvoices(stripeCustomerId: string | null, limit: number) {
  if (!stripeCustomerId) return [];
  if (!Number.isFinite(limit) || limit <= 0) { const e = new Error('limit must be a positive integer'); Object.assign(e, { code: 'invalid_request', status: 400 }); throw e; }
  const result = await stripe.invoices.list({ customer: stripeCustomerId, limit });
  return result.data.map(inv => ({ id: inv.id, amount: inv.amount_paid, currency: inv.currency, status: inv.status, period_start: fromUnix(inv.period_start), period_end: fromUnix(inv.period_end), pdf_url: inv.invoice_pdf }));
}

export async function createPortalSession(stripeCustomerId: string | null) {
  if (!stripeCustomerId) { const e = new Error('Workspace has no Stripe customer'); Object.assign(e, { code: 'no_stripe_customer', status: 400 }); throw e; }
  const session = await stripe.billingPortal.sessions.create({ customer: stripeCustomerId });
  return { url: session.url };
}
