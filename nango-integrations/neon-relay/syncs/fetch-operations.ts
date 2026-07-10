import { createSync } from "nango";
import { z } from "zod";

import { listAllOperations, listAllProjects, listOrganizations } from "../shared/neon-api.js";
import { mapOperationRecord } from "../shared/neon-mappers.js";
import { NeonOperationModel } from "../shared/neon-schemas.js";

const sync = createSync({
  description:
    "Fetches full Neon project operation history snapshots across all accessible organizations. Neon exposes cursor pagination but no changed-since filter for operations, so this sync is a full refresh.",
  version: "1.0.0",
  frequency: "every 10 minutes",
  autoStart: true,
  syncType: "full",
  metadata: z.object({}).passthrough(),
  endpoints: [{ method: "GET", path: "/neon/syncs/operations", group: "Neon" }],
  models: {
    NeonOperation: NeonOperationModel,
  },

  exec: async (nango) => {
    const organizations = await listOrganizations(nango);

    await nango.trackDeletesStart("NeonOperation");

    const records: Array<z.infer<typeof NeonOperationModel>> = [];
    for (const organization of organizations) {
      const projects = await listAllProjects(nango, organization.id);
      for (const project of projects) {
        const operations = await listAllOperations(nango, project.id);
        records.push(
          ...operations.map((operation) => NeonOperationModel.parse(mapOperationRecord(operation))),
        );
      }
    }

    if (records.length > 0) {
      await nango.batchSave(records, "NeonOperation");
    }

    await nango.trackDeletesEnd("NeonOperation");
  },
});

export default sync;
