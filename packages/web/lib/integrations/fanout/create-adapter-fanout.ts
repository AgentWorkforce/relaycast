import type { IntegrationFanout, IntegrationFanoutWebhookInput } from "./registry";

type AdapterNormalizedRecord = {
  objectType: string;
  objectId: string;
};

export function createAdapterFanout<R extends AdapterNormalizedRecord>(opts: {
  providerKey: string;
  mountRoot: `/${string}`;
  normalizeWebhook(rawPayload: unknown, headers: Record<string, string | undefined>): R;
  computePath(objectType: string, objectId: string): string;
  shouldWrite?: (record: R) => boolean;
}): IntegrationFanout<R> {
  return {
    providerKey: opts.providerKey,
    mountRoot: opts.mountRoot,
    normalizeWebhook(input: IntegrationFanoutWebhookInput): R | null {
      try {
        const headers =
          input.headers instanceof Headers
            ? (Object.fromEntries(input.headers.entries()) as Record<string, string>)
            : (input.headers as Record<string, string | undefined>);
        return opts.normalizeWebhook(input.payload, headers);
      } catch {
        return null;
      }
    },
    pathFor(record: R): string {
      return opts.computePath(record.objectType, record.objectId);
    },
    shouldWrite(record: R): boolean {
      return opts.shouldWrite ? opts.shouldWrite(record) : true;
    },
  };
}
