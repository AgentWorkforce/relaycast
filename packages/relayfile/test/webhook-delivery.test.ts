import { describe, expect, it } from "vitest";
import {
  eventMatchesAnyWebhookGlob,
  queueNameMatchesWebhookDelivery,
  validateOutboundWebhookUrl,
} from "../src/webhook-delivery.js";

describe("webhook delivery helpers", () => {
  it("matches filesystem events with relayfile path globs", () => {
    expect(
      eventMatchesAnyWebhookGlob("/linear/issues/AGE-1.json", [
        "/linear/issues/**",
      ]),
    ).toBe(true);
    expect(
      eventMatchesAnyWebhookGlob("/linear/projects/PRJ-1.json", [
        "/linear/issues/**",
      ]),
    ).toBe(false);
    expect(
      eventMatchesAnyWebhookGlob(
        "/github/repos/acme/api/issues/by-id/2174.json",
        ["/github/repos/*"],
      ),
    ).toBe(false);
    expect(
      eventMatchesAnyWebhookGlob(
        "/github/repos/acme/api/issues/by-id/2174.json",
        ["/github/repos/**"],
      ),
    ).toBe(true);
  });

  it("rejects webhook URLs that could target local or private networks", () => {
    expect(validateOutboundWebhookUrl("http://example.com/hook").ok).toBe(
      false,
    );
    expect(validateOutboundWebhookUrl("https://localhost/hook").ok).toBe(false);
    expect(validateOutboundWebhookUrl("https://127.0.0.1/hook").ok).toBe(false);
    expect(validateOutboundWebhookUrl("https://10.1.2.3/hook").ok).toBe(false);
    expect(validateOutboundWebhookUrl("https://169.254.1.1/hook").ok).toBe(
      false,
    );
    expect(validateOutboundWebhookUrl("https://[::1]/hook").ok).toBe(false);
    expect(validateOutboundWebhookUrl("https://[fe81::1]/hook").ok).toBe(
      false,
    );
    expect(validateOutboundWebhookUrl("https://[fe9f::1]/hook").ok).toBe(
      false,
    );
    expect(validateOutboundWebhookUrl("https://[febf::1]/hook").ok).toBe(
      false,
    );
    expect(
      validateOutboundWebhookUrl("https://[::ffff:192.168.1.1]/hook").ok,
    ).toBe(false);
  });

  it("supports optional destination host allowlists", () => {
    expect(
      validateOutboundWebhookUrl(
        "https://factory.example.com/hook",
        "*.example.com",
      ).ok,
    ).toBe(true);
    expect(
      validateOutboundWebhookUrl(
        "https://factory.other.com/hook",
        "*.example.com",
      ).ok,
    ).toBe(false);
  });

  it("recognizes the relayfile webhook queue branch", () => {
    expect(queueNameMatchesWebhookDelivery("relayfile-webhooks")).toBe(true);
    expect(queueNameMatchesWebhookDelivery("relayfile-webhooks-pr-267")).toBe(
      true,
    );
    expect(queueNameMatchesWebhookDelivery("relayfile-writeback")).toBe(false);
  });
});
