import { describe, it } from "node:test";
import assert from "node:assert/strict";

const observerModule = await import(
  new URL("../packages/web/lib/relayfile-observer.ts", import.meta.url).href
);
const {
  buildRelayfileObserverFragment,
  buildRelayfileObserverLaunchHtml,
  buildRelayfileObserverLaunchUrl,
  canLaunchRelayfileObserver,
  RELAYFILE_OBSERVER_PATH,
  resolveRelayfileObserverPublicOrigin,
} = (observerModule.default ?? observerModule) as typeof import("../packages/web/lib/relayfile-observer.ts");

describe("RelayFile observer launch URLs", () => {
  it("only allows session auth to mint observer launch tokens", () => {
    assert.equal(
      canLaunchRelayfileObserver(
        {
          source: "session",
          context: { workspaces: [{ id: "workspace-a" }] },
        },
        "workspace-a",
      ),
      true,
    );
    assert.equal(
      canLaunchRelayfileObserver(
        {
          source: "token",
          context: { workspaces: [{ id: "workspace-a" }] },
        },
        "workspace-a",
      ),
      false,
    );
    assert.equal(
      canLaunchRelayfileObserver(
        {
          source: "session",
          context: { workspaces: [{ id: "workspace-a" }] },
        },
        "workspace-b",
      ),
      false,
    );
  });

  it("builds a single-encoded fragment for browser runtime config", () => {
    const fragment = buildRelayfileObserverFragment({
      baseUrl: "https://api.relayfile.dev/",
      token: "token-with+/=",
      workspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
    });

    assert.equal(fragment.includes("%25"), false);

    const parsed = new URLSearchParams(fragment);
    assert.equal(parsed.get("baseUrl"), "https://api.relayfile.dev");
    assert.equal(parsed.get("token"), "token-with+/=");
    assert.equal(parsed.get("workspaceId"), "50587328-441d-4acb-b8f3-dbe1b3c5de99");
  });

  it("targets the routed observer path outside the cloud base path", () => {
    for (const origin of [
      "https://agentrelay.com",
      "https://agentrelay.com/cloud",
      "https://agentrelay.com/cloud/",
    ]) {
      const launchUrl = buildRelayfileObserverLaunchUrl(origin, {
        baseUrl: "https://api.relayfile.dev",
        token: "token",
        workspaceId: "workspace",
      });

      const [rawUrl, rawFragment] = launchUrl.split("#");
      assert.equal(rawUrl, `https://agentrelay.com${RELAYFILE_OBSERVER_PATH}`);
      assert.equal(rawUrl.includes("/cloud/observer/file"), false);
      assert.equal(new URLSearchParams(rawFragment).get("workspaceId"), "workspace");
    }
  });

  it("builds browser handoff HTML for the exact observer URL", () => {
    const launchUrl = buildRelayfileObserverLaunchUrl("https://agentrelay.com/cloud", {
      baseUrl: "https://api.relayfile.dev",
      token: "token<&",
      workspaceId: "workspace",
    });

    const html = buildRelayfileObserverLaunchHtml(launchUrl);
    const scriptTarget = html.match(/window\.location\.replace\((".*")\);/);

    assert.ok(scriptTarget);
    assert.equal(JSON.parse(scriptTarget[1]), launchUrl);
    assert.equal(html.includes("/cloud/observer/file"), false);
    assert.equal(html.includes("&token="), false);
    assert.match(html, /<meta name="referrer" content="no-referrer">/);
  });

  it("uses the forwarded public host for observer redirects", () => {
    const origin = resolveRelayfileObserverPublicOrigin(
      new Headers({
        "x-forwarded-host": "agentrelay.com",
        "x-forwarded-proto": "https",
      }),
      "https://staging.agentrelay.com",
    );

    const launchUrl = buildRelayfileObserverLaunchUrl(origin, {
      baseUrl: "https://api.relayfile.dev",
      token: "token",
      workspaceId: "workspace",
    });

    assert.equal(launchUrl.split("#")[0], "https://agentrelay.com/observer/file");
  });

  it("ignores untrusted forwarded hosts for observer redirects", () => {
    const origin = resolveRelayfileObserverPublicOrigin(
      new Headers({
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
      }),
      "https://staging.agentrelay.com",
    );

    assert.equal(origin, "https://staging.agentrelay.com");
  });
});
