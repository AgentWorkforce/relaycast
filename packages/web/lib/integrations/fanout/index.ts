import { createAdapterFanout } from "./create-adapter-fanout";
import { GithubFanout } from "./github";
import { IntegrationFanoutRegistry } from "./registry";

import {
  normalizeLinearWebhook,
} from "@relayfile/adapter-linear";
import {
  normalizeSlackWebhook,
} from "@relayfile/adapter-slack";
import {
  normalizeFathomWebhook,
} from "@relayfile/adapter-fathom";
import {
  normalizeRecallWebhook,
} from "@relayfile/adapter-recall";
import { computeLinearPath } from "@relayfile/adapter-linear/path-mapper";
import { computeSlackPath } from "@relayfile/adapter-slack/path-mapper";
import { computeFathomPath } from "@relayfile/adapter-fathom/path-mapper";
import { computeRecallPath } from "@relayfile/adapter-recall/path-mapper";

export {
  IntegrationFanoutRegistry,
  type IntegrationFanout,
  type IntegrationFanoutWebhookInput,
} from "./registry";
export { GithubFanout } from "./github";
export { createAdapterFanout } from "./create-adapter-fanout";

export const LEGACY_RELAYFILE_FANOUT_PROVIDERS = new Set([
  // Notion: sync-based provider; no webhook normalizer — events come from
  // Nango polling, not inbound webhook delivery.
  "notion",
  // Dropbox: webhook signals an account-level change (accountIds[]), not a
  // single addressable object. Needs a sync-trigger path rather than a direct
  // relayfile write.
  "dropbox",
]);

export const registry = new IntegrationFanoutRegistry();

registry.register(GithubFanout);

registry.register(
  createAdapterFanout({
    providerKey: "linear",
    mountRoot: "/linear",
    normalizeWebhook: normalizeLinearWebhook,
    computePath: computeLinearPath,
  }),
);

registry.register(
  createAdapterFanout({
    providerKey: "slack",
    mountRoot: "/slack",
    normalizeWebhook: normalizeSlackWebhook,
    computePath: computeSlackPath,
  }),
);

registry.register(
  createAdapterFanout({
    providerKey: "fathom",
    mountRoot: "/fathom",
    normalizeWebhook: normalizeFathomWebhook,
    computePath: computeFathomPath,
  }),
);

registry.register(
  createAdapterFanout({
    providerKey: "recall",
    mountRoot: "/recall",
    normalizeWebhook: normalizeRecallWebhook,
    computePath: computeRecallPath,
  }),
);
