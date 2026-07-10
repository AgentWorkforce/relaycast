import { describe, expect, it } from "vitest";
import { translatePersonaRelayToInboxSelectors } from "./inbox-selectors";

describe("translatePersonaRelayToInboxSelectors", () => {
  it("normalizes inbox selectors from persona relay fields and agent.inbox", () => {
    expect(
      translatePersonaRelayToInboxSelectors({
        persona: {
          relay: {
            enabled: true,
            inbox: ["#support", "@self"],
            channels: ["#ops", "triage"],
          },
        },
        agent: {
          inbox: [{ channels: ["#support", "#reviews"] }],
        },
      }),
    ).toEqual(["@self", "ops", "reviews", "support", "triage"]);
  });

  it("uses raw persona relay fields when the parsed persona omits relay metadata", () => {
    expect(
      translatePersonaRelayToInboxSelectors({
        persona: {},
        rawPersona: {
          relay: {
            inbox: ["#launch"],
          },
        },
      }),
    ).toEqual(["launch"]);
  });

  it("ignores disabled relay config and unsupported @user selectors", () => {
    expect(
      translatePersonaRelayToInboxSelectors({
        persona: {
          relay: {
            enabled: false,
            inbox: ["#support"],
          },
        },
        agent: {
          inbox: ["@someone"],
        },
      }),
    ).toEqual([]);
  });

  it("defaults to @self when no relay/inbox is declared (relay-on by default)", () => {
    expect(translatePersonaRelayToInboxSelectors({ persona: {} })).toEqual(["@self"]);
    expect(
      translatePersonaRelayToInboxSelectors({ persona: { id: "hn-monitor", harness: "claude" } }),
    ).toEqual(["@self"]);
  });

  it("defaults to @self when relay is enabled but lists no inbox/channels", () => {
    expect(
      translatePersonaRelayToInboxSelectors({ persona: { relay: { enabled: true } } }),
    ).toEqual(["@self"]);
  });

  it("opt-out: relay.enabled:false with no other selectors yields no inbox", () => {
    expect(
      translatePersonaRelayToInboxSelectors({ persona: { relay: { enabled: false } } }),
    ).toEqual([]);
  });

  it("explicit selectors still win over the @self default", () => {
    expect(
      translatePersonaRelayToInboxSelectors({ persona: { relay: { inbox: ["#ops"] } } }),
    ).toEqual(["ops"]);
  });

  it("precedence: resolved persona relay config overrides raw persona relay config", () => {
    // persona enables relay, rawPersona disables it → resolved persona wins → @self
    expect(
      translatePersonaRelayToInboxSelectors({
        persona: { relay: { enabled: true } },
        rawPersona: { relay: { enabled: false } },
      }),
    ).toEqual(["@self"]);
    // persona disables relay, rawPersona enables it → resolved persona wins → []
    expect(
      translatePersonaRelayToInboxSelectors({
        persona: { relay: { enabled: false } },
        rawPersona: { relay: { enabled: true } },
      }),
    ).toEqual([]);
    // persona has no relay block → fall back to rawPersona's disposition
    expect(
      translatePersonaRelayToInboxSelectors({
        persona: {},
        rawPersona: { relay: { enabled: false } },
      }),
    ).toEqual([]);
  });
});
