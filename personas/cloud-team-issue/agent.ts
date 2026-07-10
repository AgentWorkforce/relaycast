import { defineAgent } from "@agentworkforce/runtime";

const agentHandler = async (ctx, event) => {
  // v4 runtime event contract: there is no `event.source` (see the sibling
  // small-issue/complex-issue personas for the full migration rationale) —
  // the provider lives at `event.resource.provider`.
  ctx.log("info", "cloud-team-issue persona is dormant; web teamSolve N=1 adapter owns member launch", {
    eventId: event.id,
    provider: event.resource?.provider,
    type: event.type,
  });
};

export default defineAgent({
  triggers: {
    github: [
      {
        on: "issues.labeled",
        paths: ["/github/repos/AgentWorkforce/cloud/issues/**"],
        // Dispatch-level gate: only the `team` label wakes this (dormant)
        // persona — the web teamSolve adapter owns the live member spawn.
        where: "label.name=team",
      },
    ],
  },
  handler: agentHandler,
});
