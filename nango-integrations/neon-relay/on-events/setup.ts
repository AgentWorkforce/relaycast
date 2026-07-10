import { createOnEvent } from "nango";
import { z } from "zod";

import { listOrganizations } from "../shared/neon-api.js";

const setup = createOnEvent({
  event: "post-connection-creation",
  description:
    "Resolve Neon organization IDs from the connected API key and persist to connection metadata when a connection is created.",
  version: "1.1.0",
  metadata: z.void(),

  exec: async (nango): Promise<void> => {
    try {
      const organizations = await listOrganizations(nango);
      const organizationIds = organizations.map((org) => org.id);

      const updateMetadata = nango.updateMetadata as unknown as (
        value: Record<string, unknown>,
      ) => Promise<void>;
      await updateMetadata({ organizationIds, organizations });

      await nango.log(
        `Neon organizations resolved: ${organizationIds.join(", ")}`,
      );
    } catch (error) {
      await nango.log(
        `Neon organization discovery failed: ${(error as Error).message}. ` +
          "The connection is still active; syncs will discover organizations dynamically.",
        { level: "warn" },
      );
    }
  },
});

export default setup;
