import { createSync } from "nango";
import { z } from "zod";

import {
  listAdvisorIssues,
  listAllProjects,
  listOrganizations,
} from "../shared/neon-api.js";
import { mapAdvisorIssueRecord } from "../shared/neon-mappers.js";
import { NeonAdvisorIssueModel } from "../shared/neon-schemas.js";

const sync = createSync({
  description:
    "Fetches Neon advisor issues for each accessible project. This is a full refresh because the advisor endpoint returns current findings, not incremental change feeds.",
  version: "1.0.0",
  frequency: "every 12 hours",
  autoStart: true,
  syncType: "full",
  metadata: z.object({}).passthrough(),
  endpoints: [{ method: "GET", path: "/neon/syncs/advisor-issues", group: "Neon" }],
  models: {
    NeonAdvisorIssue: NeonAdvisorIssueModel,
  },

  exec: async (nango) => {
    const organizations = await listOrganizations(nango);

    await nango.trackDeletesStart("NeonAdvisorIssue");
    const capturedAt = new Date().toISOString();
    const records: Array<z.infer<typeof NeonAdvisorIssueModel>> = [];

    for (const organization of organizations) {
      const projects = await listAllProjects(nango, organization.id);
      for (const project of projects) {
        try {
          const issues = await listAdvisorIssues(nango, {
            project_id: project.id,
            min_severity: "INFO",
          });
          records.push(
            ...issues.map((issue) =>
              NeonAdvisorIssueModel.parse(
                mapAdvisorIssueRecord(project.id, undefined, issue, capturedAt),
              ),
            ),
          );
        } catch (error) {
          await nango.log(
            `Skipping advisor issues for project ${project.id}: ${error instanceof Error ? error.message : String(error)}`,
            { level: "warn" },
          );
        }
      }
    }

    if (records.length > 0) {
      await nango.batchSave(records, "NeonAdvisorIssue");
    }

    await nango.trackDeletesEnd("NeonAdvisorIssue");
  },
});

export default sync;
