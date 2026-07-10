import { createAction } from "nango";
import { z } from "zod";

import { listOrganizations } from "../shared/neon-api.js";

const DiscoverOrganizationOutput = z.object({
  organizationIds: z.array(z.string()),
  source: z.enum(["api", "metadata"]),
});

export default createAction({
  description:
    "Discover Neon organization IDs from the connected API key and persist them to connection metadata.",
  version: "1.0.0",
  endpoint: { method: "POST", path: "/neon/organization/discover", group: "Neon" },
  input: z.void(),
  output: DiscoverOrganizationOutput,

  exec: async (nango) => {
    const organizations = await listOrganizations(nango);
    const organizationIds = organizations.map((org) => org.id);
    return { organizationIds, source: "api" as const };
  },
});
