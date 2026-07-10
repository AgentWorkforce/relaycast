import { describe, expect, it } from "vitest";
import { normalizeProviderLogoSlug } from "./ProviderLogo";

describe("normalizeProviderLogoSlug", () => {
  it("passes canonical catalog ids through unchanged", () => {
    expect(normalizeProviderLogoSlug("github")).toBe("github");
    expect(normalizeProviderLogoSlug("daytona")).toBe("daytona");
    expect(normalizeProviderLogoSlug("docker-hub")).toBe("docker-hub");
    expect(normalizeProviderLogoSlug("google-calendar")).toBe("google-calendar");
  });

  it("normalizes case and whitespace", () => {
    expect(normalizeProviderLogoSlug("  GitHub ")).toBe("github");
  });

  it("aliases x to the twitter logo slug", () => {
    // Nango's CDN soft-404s (200 text/html) on x.svg but serves
    // image/svg+xml at twitter.svg.
    expect(normalizeProviderLogoSlug("x")).toBe("twitter");
    expect(normalizeProviderLogoSlug("x-relay")).toBe("twitter");
  });

  it("strips relayfile config-key suffixes", () => {
    expect(normalizeProviderLogoSlug("github-relay")).toBe("github");
    expect(normalizeProviderLogoSlug("reddit-composio-relay")).toBe("reddit");
    expect(normalizeProviderLogoSlug("gitlab-relay")).toBe("gitlab");
  });

  it("maps the underscored composio docker hub key to the catalog slug", () => {
    expect(normalizeProviderLogoSlug("docker_hub-composio-relay")).toBe("docker-hub");
    expect(normalizeProviderLogoSlug("docker_hub")).toBe("docker-hub");
  });

  it("does not strip -relay from product-app names that legitimately end differently", () => {
    // slack-ricky / linear-ricky are separate product apps, not relayfile
    // config keys; they pass through untouched.
    expect(normalizeProviderLogoSlug("slack-ricky")).toBe("slack-ricky");
    expect(normalizeProviderLogoSlug("linear-ricky")).toBe("linear-ricky");
  });

  it("returns empty string for blank input (component renders the glyph fallback)", () => {
    expect(normalizeProviderLogoSlug("   ")).toBe("");
  });
});
