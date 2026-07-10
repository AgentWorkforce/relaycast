import {
  createCatalogingAgent,
  createCloudWorkspaceList,
  createRelayauthApiSigner,
  CatalogingSubscriber,
} from "@cloud/cataloging-agent-core";
import { BY_STATE_SEGMENT } from "./aliases.js";
import { buildGitHubConventionFragment } from "./conventions.js";
import { activePrsInsight } from "./insights/active-prs.js";

type CatalogingGithubEnv = {
  CLOUD_API_URL?: string;
  CATALOGING_CLOUD_API_URL?: string;
  CATALOGING_CLOUD_API_TOKEN?: string;
  CATALOGING_RELAYAUTH_URL?: string;
  CATALOGING_RELAYAUTH_API_KEY?: string;
  RELAYFILE_URL?: string;
  OPENROUTER_API_KEY?: string;
  [key: string]: unknown;
};

const app = createCatalogingAgent<CatalogingGithubEnv>({
  domain: "github",
  insights: [activePrsInsight],
  conventions: buildGitHubConventionFragment,
  workspaceList: createCloudWorkspaceList<CatalogingGithubEnv>({
    provider: "github",
  }),
  // Mint per-workspace relayfile tokens through RelayAuth.
  getRelayauthSigner: (env) =>
    env.CATALOGING_RELAYAUTH_API_KEY
      ? createRelayauthApiSigner({
          baseUrl: env.CATALOGING_RELAYAUTH_URL,
          apiKey: env.CATALOGING_RELAYAUTH_API_KEY,
        })
      : undefined,
});

// Re-export DO class under a stable name for the SST binding.
export { CatalogingSubscriber };
export { BY_STATE_SEGMENT };

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: unknown, ctx: ExecutionContext) {
    const request = new Request("https://cataloging-agent.local/cron", { method: "POST" });
    const response = await app.fetch(request, env as Record<string, unknown>, ctx);
    const body = await readScheduledBody(response);
    const payload = {
      event: response.ok ? "scheduled_cron_completed" : "scheduled_cron_failed",
      domain: "github",
      status: response.status,
      body,
      at: new Date().toISOString(),
    };
    const line = `[cataloging] ${JSON.stringify(payload)}`;
    if (response.ok) {
      console.log(line);
      return;
    }
    console.error(line);
    throw new Error(`cataloging github scheduled cron failed with ${response.status}`);
  },
};

async function readScheduledBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json().catch(() => null);
  }
  return response.text().catch(() => "");
}
