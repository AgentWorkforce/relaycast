import type { PersonaSummary } from "./types";

/**
 * Baked-in demo persona summaries for the 7 agents published in the
 * AgentWorkforce/agents repo. These power Phase 1 (a fully demoable E2E flow
 * with no backend) and act as a graceful fallback in later phases if the live
 * `POST /api/persona/resolve` compile is unavailable.
 *
 * Keyed by the repo path slug (the folder name in the agents repo, which is the
 * second-to-last path segment of the `?persona=` GitHub blob URL).
 */

const githubIntegration = (description: string) => ({
  provider: "github",
  label: "GitHub",
  providerConfigKey: "github",
  description,
});

const slackIntegration = (description: string) => ({
  provider: "slack",
  label: "Slack",
  providerConfigKey: "slack",
  description,
});

const linearIntegration = (description: string) => ({
  provider: "linear",
  label: "Linear",
  providerConfigKey: "linear",
  description,
});

export const DEMO_PERSONAS: Record<string, PersonaSummary> = {
  review: {
    id: "pr-reviewer",
    name: "Review Agent",
    slug: "review",
    tagline: "Reviews every PR, fixes what's broken, merges when you approve.",
    description:
      "Reviews new PRs, fixes the issues found (its own + other bots'), resolves failing CI and merge conflicts, pings you on Slack when ready, and merges once you approve.",
    harness: "codex",
    model: "gpt-5.5",
    modelProvider: "openai",
    useSubscription: false,
    integrations: [
      githubIntegration("Read PRs, push fixes, resolve CI + conflicts, and merge."),
      slackIntegration("Ping you when a PR is ready for your approval."),
    ],
    inputs: [
      {
        key: "SLACK_CHANNEL",
        description: "Slack channel to post review updates to.",
        optional: true,
        picker: { provider: "slack", resource: "channels" },
      },
      {
        key: "APPROVERS",
        description: "GitHub logins whose approval merges the PR. If unset, any approval merges.",
        optional: true,
        picker: { provider: "github", resource: "users" },
      },
      {
        key: "REVIEW_AUTHORS",
        description: "Only review PRs opened by these GitHub logins. If unset, every author is reviewed.",
        optional: true,
        picker: { provider: "github", resource: "users" },
      },
      {
        key: "SKIP_LABELS",
        description: 'PR labels that disable the reviewer. Defaults to "no-agent-relay-review".',
        optional: true,
      },
    ],
    triggers: [
      { kind: "integration", provider: "github", label: "A PR is opened, updated, reviewed, or CI finishes" },
    ],
  },
  granola: {
    id: "granola-prospect",
    name: "Granola Agent",
    slug: "granola",
    tagline: "Turns prospect calls into a Linear issue and an implementing PR.",
    description:
      "When a Granola recording lands, detects prospect calls, files a Linear issue with the ask, and opens a GitHub PR implementing it.",
    harness: "claude",
    model: "claude-sonnet-4-6",
    modelProvider: "anthropic",
    useSubscription: true,
    integrations: [
      { provider: "granola", label: "Granola", providerConfigKey: "granola", description: "Receive new meeting recordings." },
      linearIntegration("File an issue capturing the prospect's ask."),
      githubIntegration("Open a PR implementing the requested change."),
    ],
    inputs: [
      {
        key: "LINEAR_TEAM_ID",
        description: "Linear team to file prospect issues under (only needed if you have multiple teams).",
        optional: true,
        picker: { provider: "linear", resource: "teams" },
      },
    ],
    triggers: [
      { kind: "integration", provider: "granola", label: "A new Granola note is synced (file.created)" },
    ],
  },
  linear: {
    id: "linear-implementer",
    name: "Linear Agent",
    slug: "linear",
    tagline: "Implements labelled Linear issues and opens the PR.",
    description:
      "Implements the issue and opens a GitHub PR; comments the PR link back on the Linear issue.",
    harness: "codex",
    model: "gpt-5.5",
    modelProvider: "openai",
    useSubscription: false,
    integrations: [
      linearIntegration("Listen for labelled issues + comment the PR link back."),
      githubIntegration("Open a PR implementing the issue."),
    ],
    inputs: [
      {
        key: "TRIGGER_LABEL",
        description: "Only implement issues with this label.",
        optional: true,
        default: "agent",
      },
    ],
    triggers: [
      { kind: "integration", provider: "linear", label: "A Linear issue is created (labelled) or commented" },
    ],
  },
  "repo-hygiene": {
    id: "repo-hygiene",
    name: "Repo Hygiene Agent",
    slug: "repo-hygiene",
    tagline: "Diagnoses code smells on every PR and journals to Notion.",
    description:
      "Diagnoses duplicated/dead code, divergent paths, stale skills/rules/docs, and code smells; comments findings and journals the run to Notion.",
    harness: "claude",
    model: "claude-sonnet-4-6",
    modelProvider: "anthropic",
    useSubscription: false,
    integrations: [
      githubIntegration("Read PRs and comment hygiene findings."),
      { provider: "notion", label: "Notion", providerConfigKey: "notion", description: "Journal each run." },
    ],
    inputs: [
      {
        key: "NOTION_DATABASE_ID",
        description: "Notion database to journal hygiene runs into.",
        optional: true,
        picker: { provider: "notion", resource: "databases" },
      },
    ],
    triggers: [
      { kind: "integration", provider: "github", label: "A GitHub PR is opened or updated" },
    ],
  },
  "hn-monitor": {
    id: "hn-monitor",
    name: "Hacker News Monitor",
    slug: "hn-monitor",
    tagline: "Scans HN for your topics and posts a digest to Slack.",
    description:
      "Scans Hacker News a few times a day for topics you care about and posts a summary to Slack.",
    harness: "claude",
    model: "claude-haiku-4-5-20251001",
    modelProvider: "anthropic",
    useSubscription: false,
    integrations: [slackIntegration("Post the digest to your channel.")],
    inputs: [
      {
        key: "TOPICS",
        description: "Comma-separated keywords to watch for (matched against story titles).",
        optional: false,
        default: "agents,ai,typescript,developer tools",
      },
      {
        key: "SLACK_CHANNEL",
        description: "Slack channel id to post the digest to.",
        optional: false,
        picker: { provider: "slack", resource: "channels" },
      },
    ],
    triggers: [{ kind: "schedule", provider: "schedule", label: "Twice a day" }],
  },
  "spotify-releases": {
    id: "spotify-releases",
    name: "Spotify Releases",
    slug: "spotify-releases",
    tagline: "DMs you new releases from artists you follow.",
    description:
      "Checks for new releases from artists you follow and DMs them to you.",
    harness: "claude",
    model: "claude-haiku-4-5-20251001",
    modelProvider: "anthropic",
    useSubscription: false,
    integrations: [
      { provider: "spotify", label: "Spotify", providerConfigKey: "spotify", description: "Read the artists you follow + their releases." },
      slackIntegration("DM you the new releases."),
    ],
    inputs: [],
    triggers: [{ kind: "schedule", provider: "schedule", label: "Daily" }],
  },
  "vendor-monitor": {
    id: "vendor-monitor",
    name: "Vendor Monitor",
    slug: "vendor-monitor",
    tagline: "Watches your stack for new releases and posts changes.",
    description:
      "Watches the vendors in your stack for new releases and posts changes to your team channel.",
    harness: "claude",
    model: "claude-sonnet-4-6",
    modelProvider: "anthropic",
    useSubscription: false,
    integrations: [slackIntegration("Post vendor release changes to your team channel.")],
    inputs: [
      {
        key: "VENDORS",
        description: "Comma-separated vendors/tools to watch.",
        optional: false,
        default: "vercel,nextjs,anthropic,openai",
      },
      {
        key: "SLACK_CHANNEL",
        description: "Team channel to post changes to.",
        optional: false,
        picker: { provider: "slack", resource: "channels" },
      },
    ],
    triggers: [{ kind: "schedule", provider: "schedule", label: "Weekday mornings" }],
  },
};

/**
 * Derive the repo path slug from a GitHub blob URL like
 * `https://github.com/AgentWorkforce/agents/blob/main/review/persona.ts` → "review".
 * Falls back to scanning for any known slug substring.
 */
export function slugFromPersonaUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    // .../blob/<ref>/<slug>/persona.ts → slug is second-to-last segment.
    if (parts.length >= 2) {
      const candidate = parts[parts.length - 2];
      if (candidate && DEMO_PERSONAS[candidate]) return candidate;
    }
  } catch {
    // fall through to substring scan
  }
  for (const slug of Object.keys(DEMO_PERSONAS)) {
    if (url.includes(`/${slug}/`)) return slug;
  }
  return null;
}

export function cardImageFromPersonaUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;

  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);

    if (parsed.hostname === "github.com") {
      const blobIndex = parts.indexOf("blob");
      if (blobIndex >= 0 && parts.length > blobIndex + 2 && parts.at(-1) === "persona.ts") {
        parsed.hostname = "raw.githubusercontent.com";
        parsed.pathname = `/${[
          ...parts.slice(0, blobIndex),
          ...parts.slice(blobIndex + 1, -1),
          "card-sm.png",
        ].join("/")}`;
        return parsed.toString();
      }
    }

    if (parsed.hostname === "raw.githubusercontent.com" && parts.at(-1) === "persona.ts") {
      parsed.pathname = `/${[...parts.slice(0, -1), "card-sm.png"].join("/")}`;
      return parsed.toString();
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export function demoPersonaForUrl(url: string | null | undefined): PersonaSummary {
  const slug = slugFromPersonaUrl(url);
  const base = (slug && DEMO_PERSONAS[slug]) || DEMO_PERSONAS.review;
  const fallbackSourceUrl = `https://github.com/AgentWorkforce/agents/blob/main/${base.slug}/persona.ts`;
  return {
    ...base,
    sourceUrl: url ?? undefined,
    imageUrl: cardImageFromPersonaUrl(url ?? fallbackSourceUrl),
  };
}
