import assert from "node:assert/strict";
import { test } from "vitest";

import {
  buildSummary,
  registerSummaryBuilder,
} from "../src/summary-builder.js";

const tier3Fixtures = [
  {
    provider: "shopify",
    type: "shopify.order.updated",
    raw: {
      data: {
        name: "#1001",
        fulfillment_status: "partial",
        tags: "vip, wholesale",
      },
      topic: "orders/fulfilled",
      shop_domain: "ops.example.com",
    },
    expected: {
      title: "#1001",
      status: "partial",
      labels: ["vip", "wholesale"],
      fieldsChanged: ["orders/fulfilled"],
      tags: ["shop:ops.example.com"],
    },
  },
  {
    provider: "mailgun",
    type: "mailgun.message.updated",
    raw: {
      eventData: {
        event: "delivered",
        severity: "permanent",
        tags: ["billing"],
      },
    },
    expected: {
      title: "delivered",
      status: "permanent",
      labels: ["billing"],
      tags: ["event:delivered"],
    },
  },
  {
    provider: "calendly",
    type: "calendly.event.updated",
    raw: {
      payload: {
        name: "Intro Call",
        status: "scheduled",
        location: { type: "zoom_conference" },
      },
    },
    expected: {
      title: "Intro Call",
      status: "scheduled",
      tags: ["location:zoom_conference"],
    },
  },
  {
    provider: "clickup",
    type: "clickup.task.updated",
    raw: {
      event: "taskUpdated",
      data: {
        name: "Fix queue",
        status: { status: "in progress" },
        priority: { priority: "urgent" },
        tags: [{ name: "ops" }],
      },
      history_items: [{ field: "status" }],
    },
    expected: {
      title: "Fix queue",
      status: "in progress",
      priority: "urgent",
      labels: ["ops"],
      fieldsChanged: ["status"],
      tags: ["event:taskUpdated"],
    },
  },
  {
    provider: "pipedrive",
    type: "pipedrive.deal.updated",
    raw: {
      deal: {
        title: "Renewal",
        status: "open",
        pipeline_name: "Enterprise",
      },
      event: "updated.deal",
    },
    expected: {
      title: "Renewal",
      status: "open",
      tags: ["pipeline:Enterprise", "event:updated.deal"],
    },
  },
  {
    provider: "intercom",
    type: "intercom.conversation.updated",
    raw: {
      topic: "conversation.user.created",
      data: {
        item: {
          state: "open",
          source: {
            body: {
              plain_text: "Customer cannot sign in",
            },
          },
        },
      },
    },
    expected: {
      title: "Customer cannot sign in",
      status: "open",
      tags: ["topic:conversation.user.created"],
    },
  },
  {
    provider: "sendgrid",
    type: "sendgrid.message.updated",
    raw: {
      events: [{
        event: "processed",
        type: "email",
        subject: "Quarterly Digest",
        sg_event_id: "sg_evt_1",
      }],
    },
    expected: {
      title: "processed",
      status: "email",
      fieldsChanged: ["sg_evt_1"],
      tags: ["Quarterly Digest"],
    },
  },
  {
    provider: "segment",
    type: "segment.track",
    raw: {
      event: {
        event: "Trial Started",
        type: "track",
        context: {
          library: { name: "analytics.js" },
          source: "web",
        },
      },
    },
    expected: {
      title: "Trial Started",
      status: "track",
      tags: ["library:analytics.js", "source:web"],
    },
  },
  {
    provider: "mixpanel",
    type: "mixpanel.track",
    raw: {
      data: {
        event: "Signed Up",
        type: "track",
        properties: {
          distinct_id: "user@example.com",
          $browser: "Chrome",
        },
      },
    },
    expected: {
      title: "Signed Up",
      status: "track",
      tags: ["browser:Chrome"],
    },
  },
] as const;

test("builtin internal builder keeps cron summaries registered", () => {
  assert.deepEqual(
    buildSummary({
      provider: "internal",
      type: "cron.tick",
      schedule: "*/5 * * * *",
    }),
    {
      title: "cron tick",
      status: "*/5 * * * *",
      tags: ["schedule"],
    },
  );
});

test("builtin relayfile builder uses the shared default summary sanitizer", () => {
  assert.deepEqual(
    buildSummary({
      provider: "relayfile",
      type: "linear.issue.updated",
      summary: {
        title: "Fix escalations",
        labels: ["ops", "urgent"],
      },
    }),
    {
      title: "Fix escalations",
      labels: ["ops", "urgent"],
    },
  );
});

test("provider-native builders run in the gateway production path", () => {
  assert.deepEqual(
    buildSummary({
      provider: "linear",
      type: "linear.issue.updated",
      raw: {
        data: {
          title: "Customer escalation follow-up",
          state: { name: "In Progress" },
          labels: [{ name: "ops" }],
          actionBy: { id: "usr_linear_1", name: "Ada Lovelace" },
          previousData: { title: "Old title" },
        },
      },
    }),
    {
      title: "Customer escalation follow-up",
      status: "In Progress",
      labels: ["ops"],
      actor: { id: "usr_linear_1", displayName: "Ada Lovelace" },
      fieldsChanged: ["title"],
      tags: ["state:In Progress"],
    },
  );
});

test("summary sanitization redacts obvious pii and stays compact", () => {
  assert.deepEqual(
    buildSummary({
      provider: "custom-provider",
      type: "custom.resource.updated",
      summary: {
        title: "Escalate customer john@example.com at +1 (555) 123-4567",
        actor: {
          id: "user@example.com",
          displayName: "john@example.com",
        },
        labels: ["ops", "ops"],
      },
    }),
    {
      title: "Escalate customer [redacted-email] at [redacted-number]",
      labels: ["ops"],
    },
  );
});

test("custom builders can still override provider-specific summary shaping", () => {
  registerSummaryBuilder("custom-provider", () => ({
    title: "custom title",
    tags: ["custom"],
  }));

  assert.deepEqual(
    buildSummary({
      provider: "custom-provider",
      type: "custom.resource.updated",
    }),
    {
      title: "custom title",
      tags: ["custom"],
    },
  );
});

for (const fixture of tier3Fixtures) {
  test(`tier-3 summary builder shapes ${fixture.provider} payloads`, () => {
    const summary = buildSummary({
      provider: fixture.provider,
      type: fixture.type,
      raw: fixture.raw,
    });

    assert.deepEqual(summary, fixture.expected);
    assert.ok(
      Buffer.byteLength(JSON.stringify(summary), "utf8") <= 1024,
      `${fixture.provider} summary exceeded 1KB`,
    );
  });
}
