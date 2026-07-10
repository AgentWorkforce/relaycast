import { createSync } from "nango";
import { z } from "zod";

import {
  getProject,
  getSpendingLimit,
  listAllBranches,
  listAllProjects,
  listEndpoints,
  listOrganizations,
} from "../shared/neon-api.js";
import {
  mapBranchRecord,
  mapEndpointRecord,
  mapOrganizationRecord,
  mapProjectRecord,
  mapSpendingLimitRecord,
} from "../shared/neon-mappers.js";
import {
  NeonBranchModel,
  NeonEndpointModel,
  NeonOrganizationModel,
  NeonProjectModel,
  NeonSpendingLimitModel,
} from "../shared/neon-schemas.js";

const sync = createSync({
  description:
    "Fetches Neon organizations, projects, branches, endpoints, and spending-limit snapshots via the Neon API.",
  version: "1.0.0",
  frequency: "every 6 hours",
  autoStart: true,
  syncType: "full",
  metadata: z.object({}).passthrough(),
  endpoints: [
    { method: "GET", path: "/neon/syncs/topology-organizations", group: "Neon" },
    { method: "GET", path: "/neon/syncs/topology-projects", group: "Neon" },
    { method: "GET", path: "/neon/syncs/topology-branches", group: "Neon" },
    { method: "GET", path: "/neon/syncs/topology-endpoints", group: "Neon" },
    { method: "GET", path: "/neon/syncs/topology-spending-limit", group: "Neon" },
  ],
  models: {
    NeonOrganization: NeonOrganizationModel,
    NeonProject: NeonProjectModel,
    NeonBranch: NeonBranchModel,
    NeonEndpoint: NeonEndpointModel,
    NeonSpendingLimit: NeonSpendingLimitModel,
  },

  exec: async (nango) => {
    const organizations = await listOrganizations(nango);

    for (const model of [
      "NeonOrganization",
      "NeonProject",
      "NeonBranch",
      "NeonEndpoint",
      "NeonSpendingLimit",
    ] as const) {
      await nango.trackDeletesStart(model);
    }

    const capturedAt = new Date().toISOString();
    const organizationRecords = organizations.map(mapOrganizationRecord);
    if (organizationRecords.length > 0) {
      await nango.batchSave(organizationRecords, "NeonOrganization");
    }

    const projectRecords: Array<z.infer<typeof NeonProjectModel>> = [];
    const branchRecords: Array<z.infer<typeof NeonBranchModel>> = [];
    const endpointRecords: Array<z.infer<typeof NeonEndpointModel>> = [];
    const spendingLimitRecords: Array<z.infer<typeof NeonSpendingLimitModel>> = [];

    for (const organization of organizations) {
      const projects = await listAllProjects(nango, organization.id);

      const spendingLimit = await getSpendingLimit(nango, organization.id);
      spendingLimitRecords.push(
        NeonSpendingLimitModel.parse(
          mapSpendingLimitRecord(
            organization.id,
            organization.name,
            spendingLimit,
            capturedAt,
          ),
        ),
      );

      for (const listedProject of projects) {
        const project = await getProject(nango, listedProject.id);
        projectRecords.push(NeonProjectModel.parse(mapProjectRecord(project)));

        const branches = await listAllBranches(nango, project.id);
        branchRecords.push(
          ...branches.map((branch) => NeonBranchModel.parse(mapBranchRecord(branch))),
        );

        const endpoints = await listEndpoints(nango, project.id);
        endpointRecords.push(
          ...endpoints.map((endpoint) => NeonEndpointModel.parse(mapEndpointRecord(endpoint))),
        );
      }
    }

    if (projectRecords.length > 0) {
      await nango.batchSave(projectRecords, "NeonProject");
    }
    if (branchRecords.length > 0) {
      await nango.batchSave(branchRecords, "NeonBranch");
    }
    if (endpointRecords.length > 0) {
      await nango.batchSave(endpointRecords, "NeonEndpoint");
    }
    if (spendingLimitRecords.length > 0) {
      await nango.batchSave(spendingLimitRecords, "NeonSpendingLimit");
    }

    for (const model of [
      "NeonOrganization",
      "NeonProject",
      "NeonBranch",
      "NeonEndpoint",
      "NeonSpendingLimit",
    ] as const) {
      await nango.trackDeletesEnd(model);
    }
  },
});

export default sync;
