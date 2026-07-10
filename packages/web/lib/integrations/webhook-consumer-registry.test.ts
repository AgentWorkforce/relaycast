import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

const dedupMocks = vi.hoisted(() => ({
  claimWebhookDelivery: vi.fn(),
  releaseWebhookDelivery: vi.fn(),
}));

vi.mock("@/lib/ricky/webhook-dedup", () => dedupMocks);

import {
  bootstrapRegistryFromEnv,
  WebhookConsumerRegistry,
  type NormalizedWebhook,
  type WebhookConsumer,
  type WebhookConsumerPredicate,
  type WebhookProvider,
} from "./webhook-consumer-registry";
import { logger } from "../logger";

type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type HttpConsumer = Extract<WebhookConsumer, { kind: "http" }>;
type HttpConsumerOverrides = {
  provider?: WebhookProvider;
  providers?: readonly WebhookProvider[];
  url?: string;
  headers?: Record<string, string>;
  predicate?: WebhookConsumerPredicate;
  timeoutMs?: number;
};

type AnyFunction = (...args: any[]) => any;
type MockFunction<T extends AnyFunction> = T & {
  mock: {
    calls: Parameters<T>[];
  };
  mockImplementation(implementation: T): MockFunction<T>;
  mockResolvedValue(value: Awaited<ReturnType<T>>): MockFunction<T>;
};

const ORIGINAL_POSTHOG_KEY = process.env.POSTHOG_KEY;
const ORIGINAL_PUBLIC_POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const restoreCallbacks: Array<() => void> = [];

function okResponse(): Response {
  return new Response(null, { status: 204 });
}

function createMock<T extends AnyFunction>(implementation?: T): MockFunction<T> {
  let currentImplementation = implementation;
  const fn = ((...args: Parameters<T>): ReturnType<T> => {
    fn.mock.calls.push(args);

    if (!currentImplementation) {
      return undefined as ReturnType<T>;
    }

    return currentImplementation(...args);
  }) as MockFunction<T>;

  fn.mock = {
    calls: [],
  };
  fn.mockImplementation = (nextImplementation: T) => {
    currentImplementation = nextImplementation;
    return fn;
  };
  fn.mockResolvedValue = (value: Awaited<ReturnType<T>>) => {
    currentImplementation = (() => Promise.resolve(value)) as T;
    return fn;
  };

  return fn;
}

function createFetchMock(implementation?: FetchImpl): MockFunction<FetchImpl> {
  return createMock<FetchImpl>(implementation ?? (async () => okResponse()));
}

function spyOnMethod<T extends object, K extends keyof T>(
  target: T,
  key: K,
  implementation?: Extract<T[K], AnyFunction>,
): MockFunction<Extract<T[K], AnyFunction>> {
  const original = target[key];
  assert.equal(typeof original, "function");

  const fallback = ((...args: unknown[]) =>
    (original as AnyFunction).apply(target, args)) as Extract<T[K], AnyFunction>;
  const spy = createMock<Extract<T[K], AnyFunction>>(implementation ?? fallback);
  const mutableTarget = target as Record<PropertyKey, unknown>;

  mutableTarget[key as PropertyKey] = spy;
  restoreCallbacks.push(() => {
    mutableTarget[key as PropertyKey] = original;
  });

  return spy;
}

function assertCallCount(mock: MockFunction<AnyFunction>, expected: number): void {
  assert.equal(mock.mock.calls.length, expected);
}

function assertRecordContains(
  actual: unknown,
  expected: Record<string, unknown>,
): asserts actual is Record<string, unknown> {
  assert.equal(actual !== null && typeof actual === "object", true);

  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual((actual as Record<string, unknown>)[key], value);
  }
}

function quietLogger() {
  return {
    info: createMock<(message: string, context?: Record<string, unknown>) => void>(),
    warn: createMock<(message: string, context?: Record<string, unknown>) => void>(),
    error: createMock<(message: string, context?: Record<string, unknown>) => void>(),
  };
}

function createEvent(overrides: Partial<NormalizedWebhook> = {}): NormalizedWebhook {
  return {
    provider: "slack",
    connectionId: "conn_123",
    workspaceId: "workspace_123",
    eventType: "message.created",
    payload: {
      text: "hello",
    },
    ...overrides,
  };
}

function httpConsumer(
  id: string,
  overrides: HttpConsumerOverrides = {},
): HttpConsumer {
  const base = {
    id,
    kind: "http",
    url: overrides.url ?? `https://example.test/${id}`,
    headers: overrides.headers,
    predicate: overrides.predicate,
    timeoutMs: overrides.timeoutMs,
  } as const;

  if (overrides.providers) {
    return {
      ...base,
      providers: overrides.providers,
    };
  }

  return {
    ...base,
    provider: overrides.provider ?? "slack",
  };
}

function registryWith(fetchImpl = createFetchMock()): WebhookConsumerRegistry {
  return new WebhookConsumerRegistry({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    logger: quietLogger(),
  });
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}

beforeEach(() => {
  delete process.env.POSTHOG_KEY;
  delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  dedupMocks.claimWebhookDelivery.mockResolvedValue(true);
  dedupMocks.releaseWebhookDelivery.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const restore of restoreCallbacks.splice(0).reverse()) {
    restore();
  }

  restoreEnvValue("POSTHOG_KEY", ORIGINAL_POSTHOG_KEY);
  restoreEnvValue("NEXT_PUBLIC_POSTHOG_KEY", ORIGINAL_PUBLIC_POSTHOG_KEY);
});

describe("WebhookConsumerRegistry", () => {
  it("register() then list(provider) returns the registered consumer", () => {
    const registry = registryWith();
    const consumer = httpConsumer("slack-consumer");

    registry.register(consumer);

    assert.deepEqual(registry.list("slack"), [consumer]);
    assert.deepEqual(registry.list("github"), []);
  });

  it("fanout() with two http consumers records both as succeeded", async () => {
    const fetchImpl = createFetchMock();
    const registry = registryWith(fetchImpl);
    registry.register(httpConsumer("first"));
    registry.register(httpConsumer("second"));

    const result = await registry.fanout("slack", createEvent());

    assert.deepEqual(result, {
      total: 2,
      succeeded: ["first", "second"],
      failed: [],
      skipped: [],
    });
    assertCallCount(fetchImpl, 2);
  });

  it("fanout() with one rejected http consumer records failure and still fires the other consumers", async () => {
    const fetchImpl = createFetchMock(async (input) => {
      if (String(input) === "https://example.test/failing") {
        throw new Error("network unavailable");
      }

      return okResponse();
    });
    const registry = registryWith(fetchImpl);
    registry.register(httpConsumer("failing"));
    registry.register(httpConsumer("still-runs"));

    const result = await registry.fanout("slack", createEvent());

    assert.deepEqual(result, {
      total: 2,
      succeeded: ["still-runs"],
      failed: [{ id: "failing", error: "network unavailable" }],
      skipped: [],
    });
    assertCallCount(fetchImpl, 2);
    assert.deepEqual(fetchImpl.mock.calls.map(([input]) => String(input)), [
      "https://example.test/failing",
      "https://example.test/still-runs",
    ]);
  });

  it("fanout() with a timed-out http consumer records timeout failure and still fires the other consumers", async () => {
    const slowSignals: AbortSignal[] = [];
    const fetchImpl = createFetchMock((input, init) => {
      if (String(input) !== "https://example.test/times-out") {
        return Promise.resolve(okResponse());
      }

      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          slowSignals.push(signal);
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }
      });
    });
    const registry = registryWith(fetchImpl);
    registry.register(httpConsumer("times-out", { timeoutMs: 5 }));
    registry.register(httpConsumer("still-runs"));

    const result = await registry.fanout("slack", createEvent());

    assert.deepEqual(result, {
      total: 2,
      succeeded: ["still-runs"],
      failed: [{ id: "times-out", error: "Timed out after 5ms" }],
      skipped: [],
    });
    assertCallCount(fetchImpl, 2);
    assert.equal(slowSignals.length, 1);
    assert.equal(slowSignals[0].aborted, true);
  });

  it("fanout() with predicate returning false records skipped and never calls the consumer", async () => {
    const fetchImpl = createFetchMock();
    const predicate = createMock<WebhookConsumerPredicate>(() => false);
    const registry = registryWith(fetchImpl);
    registry.register(httpConsumer("predicate-skip", { predicate }));

    const event = createEvent();
    const result = await registry.fanout("slack", event);

    assert.deepEqual(result, {
      total: 1,
      succeeded: [],
      failed: [],
      skipped: [{ id: "predicate-skip", reason: "predicate" }],
    });
    assertCallCount(predicate, 1);
    assert.equal(predicate.mock.calls[0][0], event);
    assertCallCount(fetchImpl, 0);
  });

  it("suppresses the #1017 same-delivery retry before proactive resolver HTTP dispatch", async () => {
    dedupMocks.claimWebhookDelivery
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const fetchImpl = createFetchMock();
    const registry = registryWith(fetchImpl);
    registry.register(httpConsumer("proactive-issue-resolver", { provider: "github" }));

    const event = createEvent({
      provider: "github",
      eventType: "issues.opened",
      workspaceId: "workspace_123",
      deliveryId: "github-delivery-1",
    });

    const first = await registry.fanout(
      "github",
      event,
    );
    const second = await registry.fanout(
      "github",
      event,
    );

    assert.deepEqual(first, {
      total: 1,
      succeeded: ["proactive-issue-resolver"],
      failed: [],
      skipped: [],
    });
    assert.deepEqual(second, {
      total: 1,
      succeeded: [],
      failed: [],
      skipped: [{ id: "proactive-issue-resolver", reason: "dedupe" }],
    });
    assert.deepEqual(dedupMocks.claimWebhookDelivery.mock.calls[0][0], {
      surface: "webhook-dispatch",
      deliveryId: "workspace_123:github:proactive-issue-resolver:github-delivery-1",
    });
    assertCallCount(fetchImpl, 1);
  });

  it("releases proactive issue resolver HTTP claim when dispatch fails", async () => {
    const fetchImpl = createFetchMock(async () =>
      new Response("bad gateway", { status: 502 }),
    );
    const registry = registryWith(fetchImpl);
    registry.register(httpConsumer("proactive-issue-resolver", { provider: "github" }));

    const result = await registry.fanout(
      "github",
      createEvent({
        provider: "github",
        eventType: "issues.opened",
        workspaceId: "workspace_123",
        deliveryId: "github-delivery-2",
      }),
    );

    assert.deepEqual(result, {
      total: 1,
      succeeded: [],
      failed: [{ id: "proactive-issue-resolver", error: "HTTP 502: bad gateway" }],
      skipped: [],
    });
    assert.deepEqual(dedupMocks.releaseWebhookDelivery.mock.calls[0][0], {
      surface: "webhook-dispatch",
      deliveryId: "workspace_123:github:proactive-issue-resolver:github-delivery-2",
    });
  });

  it("fail-closes proactive issue resolver HTTP fanout when the dedupe claim errors", async () => {
    dedupMocks.claimWebhookDelivery.mockRejectedValueOnce(new Error("dedupe unavailable"));
    const fetchImpl = createFetchMock();
    const registry = registryWith(fetchImpl);
    registry.register(httpConsumer("proactive-issue-resolver", { provider: "github" }));

    const result = await registry.fanout(
      "github",
      createEvent({
        provider: "github",
        eventType: "issues.opened",
        deliveryId: "github-delivery-3",
      }),
    );

    assert.deepEqual(result, {
      total: 1,
      succeeded: [],
      failed: [{ id: "proactive-issue-resolver", error: "dedupe unavailable" }],
      skipped: [],
    });
    assertCallCount(fetchImpl, 0);
  });

  it("fanout() with an empty registry resolves an empty result without throwing", async () => {
    const fetchImpl = createFetchMock();
    const registry = registryWith(fetchImpl);

    const result = await registry.fanout("slack", createEvent());

    assert.deepEqual(result, {
      total: 0,
      succeeded: [],
      failed: [],
      skipped: [],
    });
    assertCallCount(fetchImpl, 0);
  });

  it("register() with duplicate id replaces the consumer, does not throw, and logs a warning", () => {
    const warnSpy = spyOnMethod(console, "warn", () => undefined);
    const registry = new WebhookConsumerRegistry({
      fetchImpl: createFetchMock() as unknown as typeof fetch,
    });

    assert.doesNotThrow(() => {
      registry.register(httpConsumer("duplicate", { provider: "slack" }));
      registry.register(httpConsumer("duplicate", { provider: "github" }));
    });

    assert.deepEqual(registry.list("slack"), []);
    assert.deepEqual(registry.list("github"), [
      httpConsumer("duplicate", { provider: "github" }),
    ]);
    assertCallCount(warnSpy, 1);
    assert.equal(warnSpy.mock.calls[0][0], "Webhook consumer id already registered; replacing");
    assertRecordContains(warnSpy.mock.calls[0][1], {
      area: "webhook-fanout",
      consumerId: "duplicate",
    });
  });
});

describe("bootstrapRegistryFromEnv", () => {
  it("legacy WEBHOOK_CONSUMERS_JSON still registers consumers alongside typed defaults (deprecated path)", () => {
    const fetchImpl = createFetchMock();
    const warnSpy = spyOnMethod(logger, "warn", async () => undefined);
    const registry = bootstrapRegistryFromEnv(
      {
        WEBHOOK_CONSUMERS_JSON: JSON.stringify({
          consumers: [
            {
              id: "env-slack",
              provider: "slack",
              kind: "http",
              url: "https://example.test/slack",
              headers: {
                authorization: "Bearer token",
                "x-retry": 3,
              },
              timeoutMs: "250",
            },
            {
              id: "env-multi",
              providers: ["github", "linear"],
              url: "https://example.test/multi",
            },
          ],
        }),
      },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        logger: quietLogger(),
      },
    );

    const slackConsumers = registry.list("slack");
    assert.equal(slackConsumers.length, 2);
    assertRecordContains(slackConsumers[0], {
      id: "sage",
      provider: "slack",
      kind: "http",
      url: "https://sage.agentrelay.com/api/webhooks/slack",
      timeoutMs: 10_000,
    });
    assert.deepEqual(slackConsumers[1], {
      id: "env-slack",
      provider: "slack",
      kind: "http",
      url: "https://example.test/slack",
      headers: {
        authorization: "Bearer token",
        "x-retry": "3",
      },
      timeoutMs: 250,
    });
    assert.deepEqual(registry.list("github").map((consumer) => consumer.id), [
      "relayfile-primary",
      "env-multi",
    ]);
    assert.deepEqual(registry.list("linear").map((consumer) => consumer.id), [
      "relayfile-primary",
      "env-multi",
    ]);
    assertCallCount(warnSpy, 1);
    assert.match(String(warnSpy.mock.calls[0][0]), /deprecated/);
  });

  it("defaults to typed config when WEBHOOK_CONSUMERS_JSON is unset", () => {
    const registry = bootstrapRegistryFromEnv(
      {},
      {
        fetchImpl: createFetchMock() as unknown as typeof fetch,
        logger: quietLogger(),
      },
    );

    const slackConsumers = registry.list("slack");
    const githubConsumers = registry.list("github");
    const linearConsumers = registry.list("linear");

    assert.equal(slackConsumers.length, 1);
    assertRecordContains(slackConsumers[0], {
      id: "sage",
      provider: "slack",
      kind: "http",
      url: "https://sage.agentrelay.com/api/webhooks/slack",
      timeoutMs: 10_000,
    });
    assert.equal(githubConsumers.length, 1);
    assertRecordContains(githubConsumers[0], {
      id: "relayfile-primary",
      kind: "local",
    });
    assert.equal(linearConsumers.length, 1);
    assertRecordContains(linearConsumers[0], {
      id: "relayfile-primary",
      kind: "local",
    });
  });

  it("warns and keeps typed defaults when WEBHOOK_CONSUMERS_JSON is invalid", () => {
    const warnSpy = spyOnMethod(logger, "warn", async () => undefined);
    let registry!: WebhookConsumerRegistry;

    assert.doesNotThrow(() => {
      registry = bootstrapRegistryFromEnv(
        {
          WEBHOOK_CONSUMERS_JSON: "{invalid-json",
        },
        {
          fetchImpl: createFetchMock() as unknown as typeof fetch,
          logger: quietLogger(),
        },
      );
    });

    const slackConsumers = registry.list("slack");
    const githubConsumers = registry.list("github");
    const linearConsumers = registry.list("linear");

    assert.equal(slackConsumers.length, 1);
    assertRecordContains(slackConsumers[0], {
      id: "sage",
      provider: "slack",
      kind: "http",
      url: "https://sage.agentrelay.com/api/webhooks/slack",
      timeoutMs: 10_000,
    });
    assert.equal(githubConsumers.length, 1);
    assertRecordContains(githubConsumers[0], {
      id: "relayfile-primary",
      kind: "local",
    });
    assert.equal(linearConsumers.length, 1);
    assertRecordContains(linearConsumers[0], {
      id: "relayfile-primary",
      kind: "local",
    });
    assertCallCount(warnSpy, 1);
    assert.equal(
      warnSpy.mock.calls[0][0],
      "WEBHOOK_CONSUMERS_JSON could not be parsed; ignoring",
    );
    assertRecordContains(warnSpy.mock.calls[0][1], {
      area: "webhook-fanout",
      env: "WEBHOOK_CONSUMERS_JSON",
    });
    assert.equal(typeof warnSpy.mock.calls[0][1]?.error, "string");
  });

  it("WEBHOOK_CONSUMERS_JSON id override: JSON entry with matching id replaces typed default", () => {
    spyOnMethod(logger, "warn", async () => undefined);
    const registry = bootstrapRegistryFromEnv(
      {
        WEBHOOK_CONSUMERS_JSON: JSON.stringify({
          consumers: [
            {
              id: "sage",
              provider: "slack",
              kind: "http",
              url: "https://override.example.com",
            },
          ],
        }),
      },
      {
        fetchImpl: createFetchMock() as unknown as typeof fetch,
        logger: quietLogger(),
      },
    );

    const slackConsumers = registry.list("slack");
    assert.equal(slackConsumers.length, 1);
    assertRecordContains(slackConsumers[0], {
      id: "sage",
      provider: "slack",
      kind: "http",
      url: "https://override.example.com",
    });
  });
});
