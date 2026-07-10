import { handleProactiveRuntimeRequest } from "./handlers";
import { installRuntimeEnv } from "./runtime-env";
import { logProactiveRuntimeWorkerBootCheck } from "./resource-check";

export default {
  async fetch(
    request: Request,
    env: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<Response> {
    void ctx;
    installRuntimeEnv(env);
    logProactiveRuntimeWorkerBootCheck(env);
    return handleProactiveRuntimeRequest(request);
  },
};
