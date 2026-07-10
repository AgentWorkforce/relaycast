# cloud-team-issue

Dormant N=1 seam-proof persona for AgentWorkforce/cloud issues labeled `team`.

The deploy metadata uses the neutral `relay-orchestrator` intent because
persona-kit's deploy allowlist does not include `team-solve`. Cloud still
classifies this persona through `capabilities.teamSolve`, which is the runtime
team-solve gate.

The live launch owner is the web dispatcher:

`integration-watch-dispatcher -> dispatchTeamLaunchN1 -> launchMember`

That substrate launches exactly one member sandbox and enforces per-member
Relayfile path scoping. This persona intentionally advertises
`teamSolve.maxMembers = 1` so dispatcher routing matches the N=1 substrate.
Lead+3 / N>1 orchestration is separate forward work.

If this persona is invoked directly, its handler only logs a dormant stand-down.
It must not claim the GitHub issue, comment, enqueue workflows, or call an
in-box `ctx.team` API.
