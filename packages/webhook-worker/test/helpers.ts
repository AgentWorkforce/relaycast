import { createHash, createHmac } from "node:crypto";
import type { Env, WebhookQueueMessage } from "../src/types";

export type QueueStub = {
  sent: WebhookQueueMessage[];
  send(message: WebhookQueueMessage): Promise<void>;
};

export type R2Stub = {
  objects: Map<string, string>;
  put(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
};

export function createQueueStub(): QueueStub {
  return {
    sent: [],
    async send(message: WebhookQueueMessage) {
      this.sent.push(message);
    },
  };
}

export function createR2Stub(): R2Stub {
  return {
    objects: new Map<string, string>(),
    async put(key: string, value: string) {
      this.objects.set(key, value);
      return { key };
    },
    async get(key: string) {
      const value = this.objects.get(key);
      if (value === undefined) {
        return null;
      }
      return {
        async text() {
          return value;
        },
      };
    },
  };
}

export function createEnv(
  overrides: Partial<Env> = {},
): Env & { WEBHOOK_QUEUE: QueueStub; WEBHOOK_PAYLOADS: R2Stub } {
  const WEBHOOK_QUEUE = createQueueStub();
  const WEBHOOK_PAYLOADS = createR2Stub();

  return {
    WEBHOOK_QUEUE,
    WEBHOOK_PAYLOADS: WEBHOOK_PAYLOADS as unknown as R2Bucket,
    COMPOSIO_WEBHOOK_SECRET: "composio-secret",
    GITHUB_WEBHOOK_SECRET: "github-secret",
    HOOKDECK_WEBHOOK_SECRET: "hookdeck-secret",
    NANGO_WEBHOOK_SECRET: "nango-secret",
    ...overrides,
  } as Env & { WEBHOOK_QUEUE: QueueStub; WEBHOOK_PAYLOADS: R2Stub };
}

export async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export function signGitHub(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function signNangoHmac(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export function signNangoLegacy(body: string, secret: string): string {
  return createHash("sha256")
    .update(`${secret}${body}`)
    .digest("hex");
}

export function signHookdeck(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

export function signComposio(
  webhookId: string,
  webhookTimestamp: string,
  body: string,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(`${webhookId}.${webhookTimestamp}.${body}`)
    .digest("base64");
}
