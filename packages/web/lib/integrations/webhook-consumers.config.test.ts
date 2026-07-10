import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { getConfiguredConsumers } from "./webhook-consumers.config.js";
import type {
  NormalizedWebhook,
  WebhookConsumer,
} from "./webhook-consumer-registry.js";

type HttpConsumer = Extract<WebhookConsumer, { kind: "http" }>;

function consumerIds(consumers: WebhookConsumer[]): string[] {
  return consumers.map((consumer) => consumer.id);
}

function findHttpConsumer(
  consumers: WebhookConsumer[],
  id: string,
): HttpConsumer | undefined {
  const consumer = consumers.find((entry) => entry.id === id);
  return consumer?.kind === "http" ? consumer : undefined;
}

function assertMsdBackendAbsent(
  env: Record<string, string | undefined>,
): void {
  const consumers = getConfiguredConsumers(env);

  assert.equal(consumers.length, 2);
  assert.equal(
    consumers.some((consumer) => consumer.id === "msd-backend"),
    false,
  );
}

describe("getConfiguredConsumers", () => {
  it("returns the default sage and relayfile-primary consumers", () => {
    const consumers = getConfiguredConsumers({});
    const sage = findHttpConsumer(consumers, "sage");
    const relayfilePrimary = consumers.find(
      (consumer) => consumer.id === "relayfile-primary",
    );

    assert.equal(consumers.length, 2);
    assert.deepEqual(consumerIds(consumers), ["sage", "relayfile-primary"]);
    assert.ok(sage);
    assert.equal(sage.provider, "slack");
    assert.equal(sage.kind, "http");
    assert.equal(sage.url, "https://sage.agentrelay.com/api/webhooks/slack");
    assert.equal(sage.timeoutMs, 10_000);
    assert.ok(relayfilePrimary);
    assert.equal(relayfilePrimary.kind, "local");
  });

  it("includes msd-backend when the backend URL and token are configured", () => {
    const url = "https://msd-backend.example.test/webhooks/slack";
    const token = "token_123";
    const consumers = getConfiguredConsumers({
      WEBHOOK_MSD_BACKEND_URL: url,
      WEBHOOK_MSD_BACKEND_TOKEN: token,
    });
    const msdBackend = findHttpConsumer(consumers, "msd-backend");

    assert.equal(consumers.length, 3);
    assert.deepEqual(consumerIds(consumers), [
      "sage",
      "relayfile-primary",
      "msd-backend",
    ]);
    assert.ok(msdBackend);
    assert.equal(msdBackend.provider, "slack");
    assert.equal(msdBackend.kind, "http");
    assert.equal(msdBackend.url, url);
    assert.equal(msdBackend.headers?.Authorization, `Bearer ${token}`);
  });

  it("omits msd-backend when only the backend URL is configured", () => {
    assertMsdBackendAbsent({
      WEBHOOK_MSD_BACKEND_URL: "https://msd-backend.example.test/webhooks/slack",
    });
  });

  it("omits msd-backend when only the backend token is configured", () => {
    assertMsdBackendAbsent({
      WEBHOOK_MSD_BACKEND_TOKEN: "token_123",
    });
  });

  it("omits msd-backend when the backend URL and token are empty strings", () => {
    assertMsdBackendAbsent({
      WEBHOOK_MSD_BACKEND_URL: "",
      WEBHOOK_MSD_BACKEND_TOKEN: "",
    });
  });

  it("uses SAGE_WEBHOOK_URL as the sage base URL", () => {
    const override = "https://sage-override.example.test";
    const consumers = getConfiguredConsumers({
      SAGE_WEBHOOK_URL: override,
    });
    const sage = findHttpConsumer(consumers, "sage");

    assert.ok(sage);
    assert.equal(sage.url, `${override}/api/webhooks/slack`);
  });

  it("uses the local sage URL in development when no override is configured", () => {
    const consumers = getConfiguredConsumers({
      NODE_ENV: "development",
    });
    const sage = findHttpConsumer(consumers, "sage");

    assert.ok(sage);
    assert.ok(sage.url.startsWith("http://localhost:"), sage.url);
    assert.ok(sage.url.endsWith("/api/webhooks/slack"), sage.url);
  });

  it("includes proactive-issue-resolver when URL and token are configured", () => {
    const url = "https://proactive-issue-resolver.example.test/webhooks/github";
    const token = "proactive_token_456";
    const consumers = getConfiguredConsumers({
      PROACTIVE_ISSUE_RESOLVER_URL: url,
      PROACTIVE_ISSUE_RESOLVER_TOKEN: token,
    });
    const proactive = findHttpConsumer(consumers, "proactive-issue-resolver");

    assert.ok(proactive);
    assert.equal(proactive.provider, "github");
    assert.equal(proactive.kind, "http");
    assert.equal(proactive.url, url);
    assert.equal(proactive.headers?.Authorization, `Bearer ${token}`);
    assert.equal(typeof proactive.predicate, "function");
  });

  it("omits proactive-issue-resolver when only URL is configured", () => {
    const consumers = getConfiguredConsumers({
      PROACTIVE_ISSUE_RESOLVER_URL:
        "https://proactive-issue-resolver.example.test/webhooks/github",
    });

    assert.equal(
      consumers.some((consumer) => consumer.id === "proactive-issue-resolver"),
      false,
    );
  });

  it("omits proactive-issue-resolver when only token is configured", () => {
    const consumers = getConfiguredConsumers({
      PROACTIVE_ISSUE_RESOLVER_TOKEN: "proactive_token_456",
    });

    assert.equal(
      consumers.some((consumer) => consumer.id === "proactive-issue-resolver"),
      false,
    );
  });

  it("proactive-issue-resolver predicate matches issues.opened on My-Senior-Dev/app only", () => {
    const consumers = getConfiguredConsumers({
      PROACTIVE_ISSUE_RESOLVER_URL:
        "https://proactive-issue-resolver.example.test/webhooks/github",
      PROACTIVE_ISSUE_RESOLVER_TOKEN: "proactive_token_456",
    });
    const proactive = findHttpConsumer(consumers, "proactive-issue-resolver");

    assert.ok(proactive);
    const predicate = proactive.predicate;
    assert.ok(predicate, "expected predicate to be defined");

    const matching: NormalizedWebhook = {
      provider: "github",
      eventType: "issues.opened",
      payload: {
        repository: { full_name: "My-Senior-Dev/app" },
      },
    };
    assert.equal(predicate(matching), true);

    const wrongRepo: NormalizedWebhook = {
      provider: "github",
      eventType: "issues.opened",
      payload: {
        repository: { full_name: "octocat/hello-world" },
      },
    };
    assert.equal(predicate(wrongRepo), false);

    const wrongAction: NormalizedWebhook = {
      provider: "github",
      eventType: "issues.edited",
      payload: {
        repository: { full_name: "My-Senior-Dev/app" },
      },
    };
    assert.equal(predicate(wrongAction), false);

    const missingRepository: NormalizedWebhook = {
      provider: "github",
      eventType: "issues.opened",
      payload: {},
    };
    assert.equal(predicate(missingRepository), false);
  });
});
