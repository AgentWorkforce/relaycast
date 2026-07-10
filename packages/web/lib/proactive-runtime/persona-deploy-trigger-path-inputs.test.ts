import { describe, expect, it, vi, afterEach } from "vitest";

import {
  PersonaDeployError,
  effectiveDeployInputs,
  interpolateTriggerPathInputs,
  translatePersonaTriggersToWatchGlobs,
} from "./persona-deploy";

/**
 * Deploy-time interpolation of resolved inputs into trigger watch paths
 * (cloud#1999) + the mis-scope warnings (cloud#2000).
 *
 * Watch globs are derived from literal `trigger.paths` at deploy time, so a
 * picker-chosen channel id has to be substituted into the path before the wake
 * gate is computed — otherwise the channel must be hardcoded in source.
 */

const PERSONA_WITH_PICKER = {
  inputs: { SLACK_CHANNEL: { default: "C0DEFAULT" } },
  integrations: { slack: {} },
} as never;

describe("effectiveDeployInputs", () => {
  it("uses persona input defaults when the request omits a value", () => {
    expect(effectiveDeployInputs(PERSONA_WITH_PICKER, undefined)).toEqual({
      SLACK_CHANNEL: "C0DEFAULT",
    });
  });

  it("overlays explicit request values over defaults", () => {
    expect(effectiveDeployInputs(PERSONA_WITH_PICKER, { SLACK_CHANNEL: "C0PICKED" })).toEqual({
      SLACK_CHANNEL: "C0PICKED",
    });
  });
});

describe("interpolateTriggerPathInputs", () => {
  it("substitutes ${VAR} and $VAR in agent trigger paths (in place)", () => {
    const agent = {
      triggers: {
        slack: [{ on: "message.created", paths: ["/slack/channels/${SLACK_CHANNEL}/**"] }],
        github: [{ on: "issues.opened", paths: ["/github/repos/$OWNER/$REPO/issues/**"] }],
      },
    } as never;
    interpolateTriggerPathInputs({} as never, agent, {
      SLACK_CHANNEL: "C0PICKED",
      OWNER: "AgentWorkforce",
      REPO: "cloud",
    });
    expect((agent as { triggers: Record<string, Array<{ paths: string[] }>> }).triggers.slack[0].paths).toEqual([
      "/slack/channels/C0PICKED/**",
    ]);
    expect((agent as { triggers: Record<string, Array<{ paths: string[] }>> }).triggers.github[0].paths).toEqual([
      "/github/repos/AgentWorkforce/cloud/issues/**",
    ]);
  });

  it("interpolates legacy persona.integrations triggers and agent.watch rules", () => {
    const persona = {
      integrations: { slack: { triggers: [{ on: "message", paths: ["/slack/channels/${CH}/messages/**"] }] } },
    } as never;
    const agent = { watch: [{ paths: ["/slack/channels/${CH}/**"], events: ["created"] }] } as never;
    interpolateTriggerPathInputs(persona, agent, { CH: "C0WATCH" });
    expect(
      (persona as { integrations: Record<string, { triggers: Array<{ paths: string[] }> }> }).integrations.slack
        .triggers[0].paths,
    ).toEqual(["/slack/channels/C0WATCH/messages/**"]);
    expect((agent as { watch: Array<{ paths: string[] }> }).watch[0].paths).toEqual(["/slack/channels/C0WATCH/**"]);
  });

  it("leaves paths without references untouched", () => {
    const agent = { triggers: { slack: [{ on: "message.created", paths: ["/slack/channels/C0FIXED/**"] }] } } as never;
    interpolateTriggerPathInputs({} as never, agent, {});
    expect((agent as { triggers: Record<string, Array<{ paths: string[] }>> }).triggers.slack[0].paths).toEqual([
      "/slack/channels/C0FIXED/**",
    ]);
  });

  it("fails the deploy loudly when a referenced input is unset", () => {
    const agent = { triggers: { slack: [{ on: "message.created", paths: ["/slack/channels/${MISSING}/**"] }] } } as never;
    expect(() => interpolateTriggerPathInputs({} as never, agent, {})).toThrow(PersonaDeployError);
  });

  it("rejects unsafe input values (path traversal / glob metacharacters)", () => {
    const make = () =>
      ({ triggers: { slack: [{ on: "message.created", paths: ["/slack/channels/${CH}/**"] }] } }) as never;
    expect(() => interpolateTriggerPathInputs({} as never, make(), { CH: "../../etc" })).toThrow(PersonaDeployError);
    expect(() => interpolateTriggerPathInputs({} as never, make(), { CH: "**" })).toThrow(PersonaDeployError);
  });

  it("allows interior slashes for legitimately multi-segment values (owner/repo)", () => {
    const agent = { triggers: { github: [{ on: "issues.opened", paths: ["/github/repos/${REPO}/issues/**"] }] } } as never;
    interpolateTriggerPathInputs({} as never, agent, { REPO: "AgentWorkforce/cloud" });
    expect((agent as { triggers: Record<string, Array<{ paths: string[] }>> }).triggers.github[0].paths).toEqual([
      "/github/repos/AgentWorkforce/cloud/issues/**",
    ]);
  });

  it("end-to-end: interpolation makes the derived watch glob channel-scoped", () => {
    const persona = { integrations: { slack: {} } } as never;
    const agent = {
      triggers: { slack: [{ on: "message.created", paths: ["/slack/channels/${SLACK_CHANNEL}/messages/**"] }] },
    } as never;
    interpolateTriggerPathInputs(persona, agent, { SLACK_CHANNEL: "C0PICKED" });
    expect(translatePersonaTriggersToWatchGlobs(persona, agent)).toEqual(["/slack/channels/C0PICKED/messages/**"]);
  });
});

describe("slack watch-path scoping warnings (cloud#2000)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("warns when a slack trigger is unscoped (/slack/**)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const persona = { integrations: { slack: {} } } as never;
    const agent = { triggers: { slack: [{ on: "message.created", paths: ["/slack/**"] }] } } as never;
    translatePersonaTriggersToWatchGlobs(persona, agent);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("unscoped"),
      expect.objectContaining({ diag: "slack-watch-unscoped" }),
    );
  });

  it("warns when a slack watch path uses a channel NAME instead of an id", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const persona = { integrations: { slack: {} } } as never;
    const agent = { triggers: { slack: [{ on: "message", paths: ["/slack/channels/proj-cloud/messages/**"] }] } } as never;
    translatePersonaTriggersToWatchGlobs(persona, agent);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("channel NAME"),
      expect.objectContaining({ diag: "slack-watch-name-not-id", segment: "proj-cloud" }),
    );
  });

  it("does NOT warn for a channel-id-scoped slack watch path", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const persona = { integrations: { slack: {} } } as never;
    const agent = {
      triggers: { slack: [{ on: "message.created", paths: ["/slack/channels/C0AD7UU0J1G/messages/**"] }] },
    } as never;
    translatePersonaTriggersToWatchGlobs(persona, agent);
    expect(warn).not.toHaveBeenCalled();
  });
});
