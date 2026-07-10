import type { Bindings } from "./env.js";
import { cleanupStaleWorkspaces } from "./cleanup.js";

const cleanupCronWorker = {
  async scheduled(
    _event: ScheduledEvent,
    env: Bindings,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const { cleanedWorkspaces } = await cleanupStaleWorkspaces(env);
    console.log(`Cleaned up ${cleanedWorkspaces} stale workspaces`);
  },
};

export default cleanupCronWorker;
