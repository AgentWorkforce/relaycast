import { createSync } from "nango";
import { z } from "zod";

import {
  listAllBranches,
  listAllProjects,
  listBranchConsumptionHistory,
  listOrganizations,
  listProjectConsumptionHistory,
} from "../shared/neon-api.js";
import { expandBranchConsumptionRecords, expandProjectConsumptionRecords } from "../shared/neon-mappers.js";
import { NeonBranchConsumptionModel, NeonProjectConsumptionModel } from "../shared/neon-schemas.js";

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

const sync = createSync({
  description:
    "Fetches rolling Neon consumption history for projects and branches. Neon's history endpoints are bounded by an explicit time window, so this sync refreshes a fixed daily window instead of checkpointing.",
  version: "1.0.0",
  frequency: "every 12 hours",
  autoStart: true,
  syncType: "full",
  metadata: z.object({}).passthrough(),
  endpoints: [
    { method: "GET", path: "/neon/syncs/project-consumption", group: "Neon" },
    { method: "GET", path: "/neon/syncs/branch-consumption", group: "Neon" },
  ],
  models: {
    NeonProjectConsumption: NeonProjectConsumptionModel,
    NeonBranchConsumption: NeonBranchConsumptionModel,
  },

  exec: async (nango) => {
    const organizations = await listOrganizations(nango);
    const from = isoDaysAgo(14);
    const to = new Date().toISOString();

    await nango.trackDeletesStart("NeonProjectConsumption");
    await nango.trackDeletesStart("NeonBranchConsumption");

    const projectRecords: Array<z.infer<typeof NeonProjectConsumptionModel>> = [];
    const branchRecords: Array<z.infer<typeof NeonBranchConsumptionModel>> = [];

    for (const organization of organizations) {
      const projects = await listAllProjects(nango, organization.id);
      const projectNames = new Map(projects.map((project) => [project.id, project.name]));
      const branchNames = new Map<string, string>();

      for (const project of projects) {
        const branches = await listAllBranches(nango, project.id);
        for (const branch of branches) {
          branchNames.set(branch.id, branch.name);
        }
      }

      const projectConsumption = await listProjectConsumptionHistory(nango, {
        org_id: organization.id,
        from,
        to,
        granularity: "daily",
        project_ids: projects.map((project) => project.id),
      });

      for (const project of projectConsumption) {
        projectRecords.push(
          ...expandProjectConsumptionRecords(
            organization.id,
            project,
            projectNames.get(project.project_id),
            "daily",
          ).map((record) => NeonProjectConsumptionModel.parse(record)),
        );
      }

      const branchConsumption = await listBranchConsumptionHistory(nango, {
        org_id: organization.id,
        from,
        to,
        granularity: "daily",
        project_ids: projects.map((project) => project.id),
      });

      for (const branch of branchConsumption) {
        branchRecords.push(
          ...expandBranchConsumptionRecords(
            organization.id,
            branch,
            branchNames.get(branch.branch_id),
            "daily",
          ).map((record) => NeonBranchConsumptionModel.parse(record)),
        );
      }
    }

    if (projectRecords.length > 0) {
      await nango.batchSave(projectRecords, "NeonProjectConsumption");
    }
    if (branchRecords.length > 0) {
      await nango.batchSave(branchRecords, "NeonBranchConsumption");
    }

    await nango.trackDeletesEnd("NeonProjectConsumption");
    await nango.trackDeletesEnd("NeonBranchConsumption");
  },
});

export default sync;
