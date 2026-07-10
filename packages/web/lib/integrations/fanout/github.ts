import {
  computePath,
  normalizeWebhook,
  type GitHubNormalizedWebhook,
} from "@/lib/integrations/github-relayfile";
import type {
  IntegrationFanout,
  IntegrationFanoutWebhookInput,
} from "./registry";

export const GithubFanout: IntegrationFanout<GitHubNormalizedWebhook> = {
  providerKey: "github",
  mountRoot: "/github",
  normalizeWebhook(input: IntegrationFanoutWebhookInput): GitHubNormalizedWebhook | null {
    return normalizeWebhook(input);
  },
  pathFor(record: GitHubNormalizedWebhook): string {
    return computePath(record);
  },
  shouldWrite(_record: GitHubNormalizedWebhook): boolean {
    return true;
  },
};
