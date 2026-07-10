import {
  createCatalogingAgent,
  createCloudWorkspaceList,
  createRelayauthApiSigner,
  CatalogingSubscriber,
} from "@cloud/cataloging-agent-core";
import { BY_STATE_SEGMENT } from "./aliases.js";
import { buildLinearConventionFragment } from "./conventions.js";
import { byStateSubtreeForIssue, groupIssuesByState } from "./insights/by-state.js";
import { openIssuesInsight } from "./insights/open-issues.js";

type CatalogingLinearEnv = {
  CLOUD_API_URL?: string;
  CATALOGING_CLOUD_API_URL?: string;
  CATALOGING_CLOUD_API_TOKEN?: string;
  CATALOGING_RELAYAUTH_URL?: string;
  CATALOGING_RELAYAUTH_API_KEY?: string;
  RELAYFILE_URL?: string;
  OPENROUTER_API_KEY?: string;
  [key: string]: unknown;
};

const app = createCatalogingAgent<CatalogingLinearEnv>({
  domain: "linear",
  insights: [openIssuesInsight],
  conventions: buildLinearConventionFragment,
  workspaceList: createCloudWorkspaceList<CatalogingLinearEnv>({
    provider: "linear",
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
export { BY_STATE_SEGMENT, byStateSubtreeForIssue, groupIssuesByState };

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: unknown, ctx: ExecutionContext) {
    const request = new Request("https://cataloging-agent.local/cron", { method: "POST" });
    const response = await app.fetch(request, env as Record<string, unknown>, ctx);
    const body = await readScheduledBody(response);
    const payload = {
      event: response.ok ? "scheduled_cron_completed" : "scheduled_cron_failed",
      domain: "linear",
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
    throw new Error(`cataloging linear scheduled cron failed with ${response.status}`);
  },
};

async function readScheduledBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json().catch(() => null);
  }
  return response.text().catch(() => "");
}
