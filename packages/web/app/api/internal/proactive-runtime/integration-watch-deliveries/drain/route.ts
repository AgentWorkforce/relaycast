import { proxyProactiveRuntimeRequest } from "@/lib/proactive-runtime/service-client";

export async function POST(request: Request): Promise<Response> {
  return proxyProactiveRuntimeRequest(request);
}
