import type {
  BillingSubscription,
  UsageInfo,
  SubscribeRequest,
} from '@agent-relay/types';
import { HttpClient } from './client.js';

export class BillingClient {
  private client: HttpClient;

  constructor(client: HttpClient) {
    this.client = client;
  }

  async subscribe(data: SubscribeRequest): Promise<BillingSubscription> {
    return this.client.post('/v1/billing/subscribe', data);
  }

  async subscription(): Promise<BillingSubscription> {
    return this.client.get('/v1/billing/subscription');
  }

  async usage(period?: 'current' | 'previous'): Promise<UsageInfo> {
    const query: Record<string, string> = {};
    if (period) query.period = period;
    return this.client.get('/v1/billing/usage', query);
  }

  async invoices(limit?: number): Promise<unknown[]> {
    const query: Record<string, string> = {};
    if (limit) query.limit = String(limit);
    return this.client.get('/v1/billing/invoices', query);
  }

  async portal(): Promise<{ url: string }> {
    return this.client.post('/v1/billing/portal');
  }
}
