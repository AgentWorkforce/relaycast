import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveGitCloneCredentials: vi.fn(),
}));

vi.mock("@/lib/integrations/github-clone-token", () => ({
  resolveGitCloneCredentials: mocks.resolveGitCloneCredentials,
}));

import {
  githubBlobToRaw,
  PersonaResolveAuthRequiredError,
  PersonaResolveGithubAuthError,
  resolvePersonaFromUrl,
  resolvePersonaFromSources,
} from "./persona-resolve";

const CF_CONTEXT_SYMBOL = Symbol.for("__cloudflare-context__");

const fixtures = [
  {
    slug: "granola",
    id: "granola-prospect",
    integrations: ["granola", "linear", "github"],
    triggerKind: "integration",
    personaSource: `
      import { definePersona } from "@agentworkforce/persona-kit";
      export default definePersona({
        id: "granola-prospect",
        intent: "prospect-call",
        description: "When a Granola recording lands, detects prospect calls, files a Linear issue, and opens a GitHub PR implementing it.",
        cloud: true,
        useSubscription: true,
        integrations: { granola: {}, linear: {}, github: {} },
        harness: "claude",
        model: "claude-sonnet-4-6",
        onEvent: "./agent.ts"
      });
    `,
    agentSource: `
      import { defineAgent, type WorkforceCtx } from "@agentworkforce/runtime";
      export default defineAgent({
        triggers: { granola: [{ on: "file.created" }] },
        handler: async (ctx: WorkforceCtx, event) => {
          const prompt = [
            "Implement the prospect request.",
            JSON.stringify({ provider: "granola", event })
          ].join("\\n");
          await ctx.harness.run({ prompt });
        }
      });
    `,
  },
  {
    slug: "hn-monitor",
    id: "hn-monitor",
    integrations: ["slack"],
    triggerKind: "schedule",
    personaSource: `
      import { definePersona } from "@agentworkforce/persona-kit";
      export default definePersona({
        id: "hn-monitor",
        intent: "monitor",
        description: "Scans Hacker News for topics you care about and posts a digest to Slack.",
        cloud: true,
        integrations: { slack: {} },
        harness: "claude",
        model: "claude-haiku-4-5-20251001",
        onEvent: "./agent.ts"
      });
    `,
    agentSource: `
      import { defineAgent } from "@agentworkforce/runtime";
      export default defineAgent({
        schedules: [{ name: "Twice a day", cron: "0 9,17 * * *" }],
        handler: async () => {}
      });
    `,
  },
  {
    slug: "linear",
    id: "linear-chat-lead",
    integrations: ["linear"],
    triggerKind: "integration",
    personaSource: `
      import { definePersona } from "@agentworkforce/persona-kit";
      export default definePersona({
        id: "linear-chat-lead",
        intent: "relay-orchestrator",
        description: "Owns Linear agent-session chat, answers follow-up prompts, and delegates implementation requests to a coding workflow.",
        cloud: true,
        useSubscription: true,
        integrations: { linear: {} },
        inputs: {
          MENTION: { description: "Optional comma-separated Linear mention aliases.", env: "MENTION", optional: true }
        },
        model: "gpt-5.5",
        onEvent: "./agent.ts"
      });
    `,
    agentSource: `
      import { defineAgent } from "@agentworkforce/runtime";
      export default defineAgent({
        triggers: { linear: [{ on: "agent_session.created" }, { on: "issue.created" }] },
        handler: async () => {}
      });
    `,
  },
  {
    slug: "repo-hygiene",
    id: "repo-hygiene",
    integrations: ["github", "notion", "slack"],
    triggerKind: "integration",
    personaSource: `
      import { definePersona } from "@agentworkforce/persona-kit";
      export default definePersona({
        id: "repo-hygiene",
        intent: "review",
        description: "Diagnoses duplicated code, stale docs, and code smells; comments findings and journals the run to Notion.",
        cloud: true,
        useSubscription: true,
        integrations: { github: {}, notion: {}, slack: {} },
        harness: "codex",
        model: "gpt-5.5",
        onEvent: "./agent.ts"
      });
    `,
    agentSource: `
      import { defineAgent } from "@agentworkforce/runtime";
      export default defineAgent({
        triggers: { github: [{ on: "pull_request.opened" }] },
        handler: async () => {}
      });
    `,
  },
  {
    slug: "review",
    id: "pr-reviewer",
    integrations: ["github", "slack"],
    triggerKind: "integration",
    personaSource: `
      import { definePersona } from "@agentworkforce/persona-kit";
      export default definePersona({
        id: "pr-reviewer",
        intent: "review",
        description: "Reviews new PRs, fixes the issues found, resolves failing CI and merge conflicts, and pings Slack when ready.",
        cloud: true,
        integrations: { github: {}, slack: {} },
        inputs: {
          SKIP_LABELS: {
            description: "PR labels that disable the reviewer.",
            optional: true,
            default: "no-agent-relay-review"
          }
        },
        harness: "codex",
        model: "gpt-5.5",
        onEvent: "./agent.ts"
      });
    `,
    agentSource: `
      import { defineAgent } from "@agentworkforce/runtime";
      export default defineAgent({
        triggers: { github: [{ on: "pull_request.opened" }, { on: "check_suite.completed" }] },
        handler: async () => {}
      });
    `,
  },
  {
    slug: "spotify-releases",
    id: "spotify-releases",
    integrations: ["slack"],
    triggerKind: "schedule",
    personaSource: `
      import { definePersona } from "@agentworkforce/persona-kit";
      export default definePersona({
        id: "spotify-releases",
        intent: "monitor",
        description: "Checks for new releases from artists you follow and DMs them to you.",
        cloud: true,
        integrations: { slack: {} },
        onEvent: "./agent.ts"
      });
    `,
    agentSource: `
      import { defineAgent } from "@agentworkforce/runtime";
      export default defineAgent({
        schedules: [{ name: "Daily", cron: "0 15 * * *" }],
        handler: async () => {}
      });
    `,
  },
  {
    slug: "vendor-monitor",
    id: "vendor-monitor",
    integrations: ["slack"],
    triggerKind: "schedule",
    personaSource: `
      import { definePersona } from "@agentworkforce/persona-kit";
      export default definePersona({
        id: "vendor-monitor",
        intent: "monitor",
        description: "Watches the vendors in your stack for new releases and posts changes to your team channel.",
        cloud: true,
        integrations: { slack: {} },
        onEvent: "./agent.ts"
      });
    `,
    agentSource: `
      import { defineAgent } from "@agentworkforce/runtime";
      export default defineAgent({
        schedules: [{ name: "Weekday mornings", cron: "0 14 * * 1-5" }],
        handler: async () => {}
      });
    `,
  },
] as const;

function readPersonaFixture(fixture: (typeof fixtures)[number]) {
  const { slug, personaSource, agentSource } = fixture;
  const url = `https://github.com/AgentWorkforce/agents/blob/main/${slug}/persona.ts`;

  return {
    url,
    source: githubBlobToRaw(url),
    personaSource,
    agentSource,
  };
}

function setCloudflareContext(env: Record<string, unknown> | null): void {
  const slot = globalThis as Record<symbol, unknown>;
  if (env === null) {
    delete slot[CF_CONTEXT_SYMBOL];
    return;
  }
  slot[CF_CONTEXT_SYMBOL] = { env };
}

function response(body: string, init?: ResponseInit): Response {
  return new Response(body, init);
}

describe("resolvePersonaFromSources", () => {
  afterEach(() => {
    setCloudflareContext(null);
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  for (const fixture of fixtures) {
    it(`extracts PersonaSummary for ${fixture.slug}`, () => {
      const result = resolvePersonaFromSources(readPersonaFixture(fixture));

      expect(result.fallback).toBeUndefined();
      expect(result.bundle).toBeNull();
      expect(result.persona?.id).toBe(fixture.id);
      expect(result.agent).toBeTruthy();
      expect(result.summary).toMatchObject({
        id: fixture.id,
        slug: fixture.slug,
        sourceUrl: `https://github.com/AgentWorkforce/agents/blob/main/${fixture.slug}/persona.ts`,
        useSubscription: expect.any(Boolean),
      });
      expect(result.summary.description.length).toBeGreaterThan(20);
      expect(result.summary.integrations.map((integration) => integration.provider)).toEqual(fixture.integrations);
      expect(result.summary.integrations.every((integration) => (
        typeof integration.label === "string"
        && typeof integration.providerConfigKey === "string"
        && typeof integration.description === "string"
      ))).toBe(true);
      expect(result.summary.triggers.some((trigger) => trigger.kind === fixture.triggerKind)).toBe(true);
    });
  }

  it("carries picker metadata from live persona inputs into the summary", () => {
    const result = resolvePersonaFromSources({
      url: "https://github.com/AgentWorkforce/agents/blob/main/custom-picker/persona.ts",
      personaSource: `
        import { definePersona } from "@agentworkforce/persona-kit";
        export default definePersona({
          id: "custom-picker",
          intent: "monitor",
          description: "Posts selected channel updates to Slack for a configured workflow.",
          cloud: true,
          integrations: { slack: {} },
          inputs: {
            SLACK_CHANNEL: {
              description: "Slack channel id to post updates to.",
              env: "SLACK_CHANNEL",
              picker: { provider: "slack", resource: "channels" }
            }
          },
          onEvent: "./agent.ts"
        });
      `,
      agentSource: `
        import { defineAgent } from "@agentworkforce/runtime";
        export default defineAgent({
          schedules: [{ name: "Daily", cron: "0 15 * * *" }],
          handler: async () => {}
        });
      `,
    });

    expect(result.summary.inputs).toContainEqual(expect.objectContaining({
      key: "SLACK_CHANNEL",
      picker: { provider: "slack", resource: "channels" },
    }));
  });

  it("resolves integrations declared as an external const with `satisfies`", () => {
    const result = resolvePersonaFromSources({
      url: "https://github.com/AgentWorkforce/internal-agents/blob/main/github-inbox/persona.ts",
      personaSource: `
        import { definePersona } from '@agentworkforce/persona-kit';

        type IntegrationProvider = 'github' | 'slack' | 'google-mail';
        interface IntegrationCfg { scope?: Record<string, string>; }

        const integrations = {
          'google-mail': { scope: { messages: '/google-mail/messages/**' } },
          slack: { scope: { channels: '/slack/channels/**' } }
        } satisfies Partial<Record<IntegrationProvider, IntegrationCfg>>;

        export default definePersona({
          id: 'github-inbox',
          intent: 'relay-orchestrator',
          description: 'Owns your GitHub email inbox and DMs you digests on Slack.',
          cloud: true,
          useSubscription: true,
          integrations,
          onEvent: './agent.ts'
        });
      `,
    });

    expect(result.fallback).toBeUndefined();
    expect(result.summary.id).toBe("github-inbox");
    expect(result.summary.integrations.map((entry) => entry.provider).sort()).toEqual([
      "google-mail",
      "slack",
    ]);
  });

  it("resolves an array const referenced with `as const`", () => {
    const result = resolvePersonaFromSources({
      url: "https://github.com/AgentWorkforce/internal-agents/blob/main/tagged/persona.ts",
      personaSource: `
        import { definePersona } from '@agentworkforce/persona-kit';
        const tags = ['discovery', 'implementation'] as const;
        export default definePersona({
          id: 'tagged',
          intent: 'monitor',
          description: 'A persona that pins its tags via an external const array.',
          cloud: true,
          integrations: { github: {} },
          tags,
          onEvent: './agent.ts'
        });
      `,
    });

    expect(result.fallback).toBeUndefined();
    expect(result.summary.id).toBe("tagged");
    expect(result.persona?.tags).toEqual(["discovery", "implementation"]);
  });

  it("inlines a readFileSync-baked spec default from pre-resolved file consts", () => {
    const result = resolvePersonaFromSources({
      url: "https://github.com/AgentWorkforce/watchdog-agents/blob/main/customer-success/churn-digest/persona.ts",
      personaSource: `
        import { readFileSync } from 'node:fs';
        import { definePersona } from '@agentworkforce/persona-kit';
        const SPEC_MD = readFileSync(new URL('./SPEC.md', import.meta.url), 'utf-8');
        export default definePersona({
          id: 'churn-digest',
          intent: 'relay-orchestrator',
          description: 'Twice-daily Slack briefing on customer churn risk.',
          cloud: true,
          integrations: { slack: {} },
          inputs: {
            SPEC: { description: 'Compiled-in behavior spec (from SPEC.md).', default: SPEC_MD }
          },
          onEvent: './agent.ts'
        });
      `,
      fileConsts: { SPEC_MD: "```yaml\nstale_after_days: 7\n```\nFollow this policy." },
    });

    expect(result.fallback).toBeUndefined();
    expect(result.summary.id).toBe("churn-digest");
    expect((result.persona?.inputs as Record<string, { default?: string }>).SPEC.default).toContain(
      "stale_after_days: 7",
    );
    expect(result.summary.inputs).toContainEqual(
      expect.objectContaining({ key: "SPEC", default: expect.stringContaining("Follow this policy.") }),
    );
  });

  it("resolves cron schedules built by a local helper function", () => {
    const result = resolvePersonaFromSources({
      url: "https://github.com/AgentWorkforce/watchdog-agents/blob/main/customer-success/churn-digest/persona.ts",
      personaSource: `
        import { definePersona } from '@agentworkforce/persona-kit';
        export default definePersona({
          id: 'churn-digest',
          intent: 'relay-orchestrator',
          description: 'Twice-daily Slack briefing on customer churn risk.',
          cloud: true,
          integrations: { slack: {} },
          onEvent: './agent.ts'
        });
      `,
      agentSource: `
        import { defineAgent } from '@agentworkforce/runtime';
        const OSLO = 'Europe/Oslo';
        function weekdaysAt(name: string, at: string | string[], tz: string = OSLO) {
          const times = (Array.isArray(at) ? at : [at]).map((t) => t.split(':').map(Number));
          const minute = times[0][1] || 0;
          const hours = times.map(([h]) => h).join(',');
          return { name, cron: \`\${minute} \${hours} * * 1-5\`, tz };
        }
        export default defineAgent({
          schedules: [weekdaysAt('morning', '09:00'), weekdaysAt('evening', '17:00')],
          handler: async () => {}
        });
      `,
    });

    expect(result.fallback).toBeUndefined();
    expect(result.agent?.schedules).toEqual([
      { name: "morning", cron: "0 9 * * 1-5", tz: "Europe/Oslo" },
      { name: "evening", cron: "0 17 * * 1-5", tz: "Europe/Oslo" },
    ]);
    expect(result.summary.triggers).toEqual([
      { kind: "schedule", provider: "schedule", label: "morning (0 9 * * 1-5)" },
      { kind: "schedule", provider: "schedule", label: "evening (0 17 * * 1-5)" },
    ]);
  });

  it("degrades gracefully (no demo fallback) when a schedule helper is unresolvable", () => {
    const result = resolvePersonaFromSources({
      url: "https://github.com/AgentWorkforce/watchdog-agents/blob/main/x/persona.ts",
      personaSource: `
        import { definePersona } from '@agentworkforce/persona-kit';
        export default definePersona({
          id: 'opaque-schedule',
          intent: 'monitor',
          description: 'A persona whose schedule is built by an unresolvable runtime call.',
          cloud: true,
          integrations: { slack: {} },
          onEvent: './agent.ts'
        });
      `,
      agentSource: `
        import { defineAgent } from '@agentworkforce/runtime';
        export default defineAgent({
          schedules: computeSchedulesFromNetwork(),
          handler: async () => {}
        });
      `,
    });

    // The persona core still resolves (real id/description) instead of the whole
    // thing collapsing to demo data; the schedule just isn't surfaced.
    expect(result.fallback).toBeUndefined();
    expect(result.summary.id).toBe("opaque-schedule");
    expect(result.agent?.schedules).toBeUndefined();
    expect(result.warnings?.some((w) => w.includes("unsupported dynamic syntax"))).toBe(true);
  });

  it("fills known demo picker metadata when the live persona omits it", () => {
    const result = resolvePersonaFromSources({
      url: "https://github.com/AgentWorkforce/agents/blob/main/hn-monitor/persona.ts",
      personaSource: `
        import { definePersona } from "@agentworkforce/persona-kit";
        export default definePersona({
          id: "hn-monitor",
          intent: "monitor",
          description: "Scans Hacker News for topics you care about and posts a digest to Slack.",
          cloud: true,
          integrations: { slack: {} },
          inputs: {
            TOPICS: {
              description: "Comma-separated keywords to watch for.",
              env: "TOPICS",
              default: "agents,ai,typescript,developer tools"
            },
            SLACK_CHANNEL: {
              description: "Slack channel id to post the digest to.",
              env: "SLACK_CHANNEL"
            }
          },
          onEvent: "./agent.ts"
        });
      `,
      agentSource: `
        import { defineAgent } from "@agentworkforce/runtime";
        export default defineAgent({
          schedules: [{ name: "Twice a day", cron: "0 9,17 * * *" }],
          handler: async () => {}
        });
      `,
    });

    expect(result.summary.inputs).toContainEqual(expect.objectContaining({
      key: "SLACK_CHANNEL",
      picker: { provider: "slack", resource: "channels" },
    }));
  });

  it("falls back with a warning for unsupported dynamic persona syntax", () => {
    const result = resolvePersonaFromSources({
      url: "https://github.com/AgentWorkforce/agents/blob/main/review/persona.ts",
      personaSource: `
        import { definePersona } from "@agentworkforce/persona-kit";
        const id = "dynamic-id";
        export default definePersona({
          id,
          intent: "review",
          description: "Dynamic identifiers are not worker-safe.",
          cloud: true,
          integrations: { github: {} },
          onEvent: "./agent.ts"
        });
      `,
      agentSource: `
        import { defineAgent } from "@agentworkforce/runtime";
        export default defineAgent({ triggers: { github: [{ on: "pull_request.opened" }] }, handler: async () => {} });
      `,
    });

    expect(result.fallback?.reason).toContain("persona.id");
    expect(result.warnings?.[0]).toContain("unsupported dynamic syntax");
    expect(result.summary.id).toBe("pr-reviewer");
    expect(result.summary.integrations[0]).toMatchObject({
      provider: "github",
      label: "GitHub",
      providerConfigKey: "github-relay",
    });
  });

  it("calls the compile worker service binding and includes the returned bundle", async () => {
    const compileFetch = vi.fn(async (request: Request) => {
      const body = await request.json() as {
        personaId?: string;
        entryPoint?: string;
        files?: Record<string, string>;
      };
      expect(new URL(request.url).pathname).toBe("/compile");
      expect(body.personaId).toBe("pr-reviewer");
      expect(body.entryPoint).toBe("review/agent.ts");
      expect(Object.keys(body.files ?? {}).sort()).toEqual([
        "review/agent.ts",
        "review/helper.ts",
      ]);
      return Response.json({
        runner: "runner code",
        agent: "agent bundle",
        packageJson: { type: "module" },
      });
    });
    setCloudflareContext({
      PERSONA_COMPILE_WORKER: { fetch: compileFetch },
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === "string"
        ? url
        : url instanceof URL
          ? url.toString()
          : url.url;
      if (href.endsWith("/review/persona.ts")) {
        return response(`
          import { definePersona } from "@agentworkforce/persona-kit";
          export default definePersona({
            id: "pr-reviewer",
            intent: "review",
            description: "Reviews new PRs and keeps CI green.",
            cloud: true,
            integrations: { github: {} },
            harness: "codex",
            model: "gpt-5.5",
            onEvent: "./agent.ts"
          });
        `);
      }
      if (href.endsWith("/review/agent.ts")) {
        return response(`
          import { defineAgent } from "@agentworkforce/runtime";
          import { helper } from "./helper";
          export default defineAgent({
            triggers: { github: [{ on: "pull_request.opened" }] },
            handler: async () => helper()
          });
        `);
      }
      if (href.endsWith("/review/helper.ts")) {
        return response("export function helper() { return true; }");
      }
      return response("not found", { status: 404, statusText: "Not Found" });
    }));

    const result = await resolvePersonaFromUrl({
      url: "https://github.com/AgentWorkforce/agents/blob/main/review/persona.ts",
    });

    expect(result.fallback).toBeUndefined();
    expect(result.bundle).toEqual({
      runner: "runner code",
      agent: "agent bundle",
      packageJson: { type: "module" },
    });
    expect(result.summary.id).toBe("pr-reviewer");
  });

  it("fetches a readFileSync-baked SPEC.md sibling and inlines it as the input default", async () => {
    setCloudflareContext({
      PERSONA_COMPILE_WORKER: {
        fetch: vi.fn(async () =>
          Response.json({ runner: "runner code", agent: "agent bundle", packageJson: { type: "module" } })
        ),
      },
    });
    const fetched: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      fetched.push(href);
      if (href.endsWith("/customer-success/churn-digest/persona.ts")) {
        return response(`
          import { readFileSync } from 'node:fs';
          import { definePersona } from '@agentworkforce/persona-kit';
          const SPEC_MD = readFileSync(new URL('./SPEC.md', import.meta.url), 'utf-8');
          export default definePersona({
            id: 'churn-digest',
            intent: 'relay-orchestrator',
            description: 'Twice-daily Slack briefing on customer churn risk.',
            cloud: true,
            integrations: { slack: {} },
            inputs: { SPEC: { description: 'Compiled-in behavior spec.', default: SPEC_MD } },
            onEvent: './agent.ts'
          });
        `);
      }
      if (href.endsWith("/customer-success/churn-digest/SPEC.md")) {
        return response("```yaml\nstale_after_days: 9\n```\nName the biggest risk.");
      }
      if (href.endsWith("/customer-success/churn-digest/agent.ts")) {
        return response(`
          import { defineAgent } from "@agentworkforce/runtime";
          export default defineAgent({ schedules: [{ name: "Daily", cron: "0 15 * * *" }], handler: async () => {} });
        `);
      }
      return response("not found", { status: 404, statusText: "Not Found" });
    }));

    const result = await resolvePersonaFromUrl({
      url: "https://github.com/AgentWorkforce/watchdog-agents/blob/main/customer-success/churn-digest/persona.ts",
    });

    expect(result.fallback).toBeUndefined();
    expect(result.summary.id).toBe("churn-digest");
    expect((result.persona?.inputs as Record<string, { default?: string }>).SPEC.default).toContain(
      "stale_after_days: 9",
    );
    expect(fetched.some((href) => href.endsWith("/customer-success/churn-digest/SPEC.md"))).toBe(true);
  });

  it("stages CommonJS relative require dependencies for the compile worker", async () => {
    const compileFetch = vi.fn(async (request: Request) => {
      const body = await request.json() as {
        entryPoint?: string;
        files?: Record<string, string>;
      };
      expect(new URL(request.url).pathname).toBe("/compile");
      expect(body.entryPoint).toBe("review/agent.ts");
      expect(Object.keys(body.files ?? {}).sort()).toEqual([
        "review/agent.ts",
        "review/cjs-helper.js",
      ]);
      expect(body.files?.["review/agent.ts"]).toContain("require(\"./cjs-helper\")");
      expect(body.files?.["review/cjs-helper.js"]).toContain("module.exports");
      return Response.json({
        runner: "runner code",
        agent: "agent bundle",
        packageJson: { type: "module" },
      });
    });
    setCloudflareContext({
      PERSONA_COMPILE_WORKER: { fetch: compileFetch },
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === "string"
        ? url
        : url instanceof URL
          ? url.toString()
          : url.url;
      if (href.endsWith("/review/persona.ts")) {
        return response(`
          import { definePersona } from "@agentworkforce/persona-kit";
          export default definePersona({
            id: "pr-reviewer",
            intent: "review",
            description: "Reviews new PRs and keeps CI green.",
            cloud: true,
            integrations: { github: {} },
            harness: "codex",
            model: "gpt-5.5",
            onEvent: "./agent.ts"
          });
        `);
      }
      if (href.endsWith("/review/agent.ts")) {
        return response(`
          import { defineAgent } from "@agentworkforce/runtime";
          const { helper } = require("./cjs-helper");
          const ignored = require("node:path");
          export default defineAgent({
            triggers: { github: [{ on: "pull_request.opened" }] },
            handler: async () => helper()
          });
        `);
      }
      if (href.endsWith("/review/cjs-helper.js")) {
        return response("module.exports.helper = function helper() { return true; };");
      }
      return response("not found", { status: 404, statusText: "Not Found" });
    }));

    const result = await resolvePersonaFromUrl({
      url: "https://github.com/AgentWorkforce/agents/blob/main/review/persona.ts",
    });

    expect(result.fallback).toBeUndefined();
    expect(result.bundle).toEqual({
      runner: "runner code",
      agent: "agent bundle",
      packageJson: { type: "module" },
    });
    expect(compileFetch).toHaveBeenCalledOnce();
  });

  it("stages a TS source for an ESM relative import written with a .js extension", async () => {
    const compileFetch = vi.fn(async (request: Request) => {
      const body = await request.json() as {
        entryPoint?: string;
        files?: Record<string, string>;
      };
      expect(new URL(request.url).pathname).toBe("/compile");
      expect(body.entryPoint).toBe("customer-success/customer-health/agent.ts");
      expect(Object.keys(body.files ?? {}).sort()).toEqual([
        "customer-success/customer-health/agent.ts",
        "customer-success/customer-health/router.ts",
      ]);
      expect(body.files?.["customer-success/customer-health/agent.ts"]).toContain(
        "from \"./router.js\"",
      );
      expect(body.files?.["customer-success/customer-health/router.ts"]).toContain(
        "classifyIntent",
      );
      return Response.json({
        runner: "runner code",
        agent: "agent bundle",
        packageJson: { type: "module" },
      });
    });
    setCloudflareContext({
      PERSONA_COMPILE_WORKER: { fetch: compileFetch },
    });
    const fetched: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === "string"
        ? url
        : url instanceof URL
          ? url.toString()
          : url.url;
      fetched.push(href);
      if (href.endsWith("/customer-success/customer-health/persona.ts")) {
        return response(`
          import { definePersona } from "@agentworkforce/persona-kit";
          export default definePersona({
            id: "customer-health",
            intent: "relay-orchestrator",
            description: "Single Slack router for customer-success questions.",
            cloud: true,
            integrations: { slack: {} },
            harness: "claude",
            model: "claude-sonnet-4-6",
            onEvent: "./agent.ts"
          });
        `);
      }
      if (href.endsWith("/customer-success/customer-health/agent.ts")) {
        return response(`
          import { defineAgent } from "@agentworkforce/runtime";
          import { classifyIntent, type Domain } from "./router.js";
          export default defineAgent({
            triggers: { slack: [{ on: "message.created" }] },
            handler: async () => classifyIntent("hi")
          });
        `);
      }
      if (href.endsWith("/customer-success/customer-health/router.ts")) {
        return response("export function classifyIntent(_text: string) { return \"unknown\"; }");
      }
      return response("not found", { status: 404, statusText: "Not Found" });
    }));

    const result = await resolvePersonaFromUrl({
      url: "https://github.com/AgentWorkforce/watchdog-agents/blob/main/customer-success/customer-health/persona.ts",
    });

    expect(result.fallback).toBeUndefined();
    expect(result.bundle).toEqual({
      runner: "runner code",
      agent: "agent bundle",
      packageJson: { type: "module" },
    });
    // The collector probes the literal .js first (404s), then falls back to the .ts sibling.
    expect(fetched.some((href) => href.endsWith("/customer-success/customer-health/router.js"))).toBe(true);
    expect(fetched.some((href) => href.endsWith("/customer-success/customer-health/router.ts"))).toBe(true);
    expect(compileFetch).toHaveBeenCalledOnce();
  });

  it("resolves a private GitHub persona through the Contents API with workspace clone credentials", async () => {
    mocks.resolveGitCloneCredentials.mockResolvedValue({
      provider: "github",
      username: "x-access-token",
      token: "ghs_private",
    });
    const compileFetch = vi.fn(async (request: Request) => {
      const body = await request.json() as {
        entryPoint?: string;
        files?: Record<string, string>;
      };
      expect(body.entryPoint).toBe("review/agent.ts");
      expect(Object.keys(body.files ?? {}).sort()).toEqual([
        "review/agent.ts",
        "review/helper.ts",
      ]);
      return Response.json({
        runner: "runner code",
        agent: "agent bundle",
        packageJson: { type: "module" },
      });
    });
    setCloudflareContext({
      PERSONA_COMPILE_WORKER: { fetch: compileFetch },
    });
    const fetchCalls: Array<{ url: string; authorization: string | null; accept: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === "string"
        ? url
        : url instanceof URL
          ? url.toString()
          : url.url;
      const headers = new Headers(init?.headers);
      fetchCalls.push({
        url: href,
        authorization: headers.get("authorization"),
        accept: headers.get("accept"),
      });

      if (href.startsWith("https://raw.githubusercontent.com/")) {
        return response("not found", { status: 404, statusText: "Not Found" });
      }
      if (href === "https://api.github.com/repos/AgentWorkforce/agents/contents/review/persona.ts?ref=main") {
        return response(`
          import { definePersona } from "@agentworkforce/persona-kit";
          export default definePersona({
            id: "pr-reviewer",
            intent: "review",
            description: "Reviews new PRs and keeps CI green.",
            cloud: true,
            integrations: { github: {} },
            harness: "codex",
            model: "gpt-5.5",
            onEvent: "./agent.ts"
          });
        `);
      }
      if (href === "https://api.github.com/repos/AgentWorkforce/agents/contents/review/agent.ts?ref=main") {
        return response(`
          import { defineAgent } from "@agentworkforce/runtime";
          import { helper } from "./helper";
          export default defineAgent({
            triggers: { github: [{ on: "pull_request.opened" }] },
            handler: async () => helper()
          });
        `);
      }
      if (href === "https://api.github.com/repos/AgentWorkforce/agents/contents/review/helper.ts?ref=main") {
        return response("export function helper() { return true; }");
      }
      return response("not found", { status: 404, statusText: "Not Found" });
    }));

    const result = await resolvePersonaFromUrl({
      url: "https://github.com/AgentWorkforce/agents/blob/main/review/persona.ts",
      auth: {
        userId: "user-1",
        workspaceId: "workspace-1",
      },
    });

    expect(result.fallback).toBeUndefined();
    expect(result.bundle?.agent).toBe("agent bundle");
    expect(mocks.resolveGitCloneCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.resolveGitCloneCredentials).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "workspace-1",
      remoteUrl: "https://github.com/AgentWorkforce/agents",
    });
    const authenticatedCalls = fetchCalls.filter((call) => call.url.startsWith("https://api.github.com/"));
    expect(authenticatedCalls.length).toBeGreaterThanOrEqual(3);
    expect(authenticatedCalls.every((call) => call.authorization === "token ghs_private")).toBe(true);
    expect(authenticatedCalls.every((call) => call.accept === "application/vnd.github.raw")).toBe(true);
  });

  it("requires auth before retrying a private GitHub persona", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      response("not found", { status: 404, statusText: "Not Found" })
    ));

    await expect(resolvePersonaFromUrl({
      url: "https://github.com/AgentWorkforce/agents/blob/main/review/persona.ts",
    })).rejects.toBeInstanceOf(PersonaResolveAuthRequiredError);
    expect(mocks.resolveGitCloneCredentials).not.toHaveBeenCalled();
  });

  it("returns a clean private repo error when no GitHub installation can read the repo", async () => {
    mocks.resolveGitCloneCredentials.mockResolvedValue(null);
    vi.stubGlobal("fetch", vi.fn(async () =>
      response("not found", { status: 404, statusText: "Not Found" })
    ));

    await expect(resolvePersonaFromUrl({
      url: "https://github.com/AgentWorkforce/agents/blob/main/review/persona.ts",
      auth: {
        userId: "user-1",
        workspaceId: "workspace-1",
      },
    })).rejects.toBeInstanceOf(PersonaResolveGithubAuthError);
  });

  it("keeps the AST summary when the compile worker binding is unavailable", async () => {
    setCloudflareContext(null);
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === "string"
        ? url
        : url instanceof URL
          ? url.toString()
          : url.url;
      if (href.endsWith("/review/persona.ts")) {
        return response(`
          import { definePersona } from "@agentworkforce/persona-kit";
          export default definePersona({
            id: "pr-reviewer",
            intent: "review",
            description: "Reviews new PRs and keeps CI green.",
            cloud: true,
            integrations: { github: {} },
            harness: "codex",
            model: "gpt-5.5",
            onEvent: "./agent.ts"
          });
        `);
      }
      if (href.endsWith("/review/agent.ts")) {
        return response(`
          import { defineAgent } from "@agentworkforce/runtime";
          export default defineAgent({
            triggers: { github: [{ on: "pull_request.opened" }] },
            handler: async () => {}
          });
        `);
      }
      return response("not found", { status: 404, statusText: "Not Found" });
    }));

    const result = await resolvePersonaFromUrl({
      url: "https://github.com/AgentWorkforce/agents/blob/main/review/persona.ts",
    });

    expect(result.summary.id).toBe("pr-reviewer");
    expect(result.persona?.id).toBe("pr-reviewer");
    expect(result.bundle).toBeNull();
    expect(result.fallback?.reason).toContain("PERSONA_COMPILE_WORKER");
  });
});
