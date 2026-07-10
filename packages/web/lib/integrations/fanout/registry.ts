export type IntegrationFanoutWebhookInput = {
  headers: Headers | Record<string, string | undefined>;
  payload: Record<string, unknown>;
  connectionId: string;
};

export interface IntegrationFanout<Record> {
  providerKey: string;
  /**
   * Relayfile path prefix for this provider. Provider pathFor implementations
   * return full relayfile paths rooted under this prefix.
   */
  mountRoot: `/${string}`;
  normalizeWebhook(input: IntegrationFanoutWebhookInput): Record | null;
  pathFor(record: Record): string;
  /**
   * False means the adapter intentionally suppressed a record. Callers must
   * emit the event-delivery contract suppression audit row before returning 200
   * to the provider; silent drops are not allowed.
   */
  shouldWrite(record: Record): boolean;
}

export class IntegrationFanoutRegistry {
  readonly #fanouts = new Map<string, IntegrationFanout<unknown>>();

  register<Record>(fanout: IntegrationFanout<Record>): void {
    const providerKey = fanout.providerKey.trim();
    if (!providerKey) {
      throw new Error("IntegrationFanout providerKey is required.");
    }
    if (this.#fanouts.has(providerKey)) {
      throw new Error(`IntegrationFanout provider already registered: ${providerKey}`);
    }
    this.#fanouts.set(providerKey, fanout as IntegrationFanout<unknown>);
  }

  get<Record = unknown>(providerKey: string): IntegrationFanout<Record> {
    const fanout = this.#fanouts.get(providerKey);
    if (!fanout) {
      throw new Error(`IntegrationFanout provider is not registered: ${providerKey}`);
    }
    return fanout as IntegrationFanout<Record>;
  }

  has(providerKey: string): boolean {
    return this.#fanouts.has(providerKey);
  }

  providerKeys(): string[] {
    return [...this.#fanouts.keys()].sort();
  }
}
