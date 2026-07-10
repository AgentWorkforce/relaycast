import {
  resolveDeleteRequest,
  resolveWritebackRequest,
} from "@relayfile/adapter-github/writeback";
import type {
  DispatchResult,
  IntegrationCredential,
  ProviderDispatchOptions,
  WritebackEnv,
  WritebackInput,
} from "../types.js";
import {
  dispatchStandardRequest,
  permanentFailure,
  type AdapterProxyRequest,
} from "./common.js";

export async function dispatch(
  input: WritebackInput,
  cred: IntegrationCredential,
  env: WritebackEnv,
  options: ProviderDispatchOptions = {},
): Promise<DispatchResult> {
  let request: AdapterProxyRequest;
  try {
    request =
      input.action === "file_delete"
        ? (resolveDeleteRequest(input.path) as AdapterProxyRequest)
        : (resolveWritebackRequest(
            input.path,
            input.content,
          ) as AdapterProxyRequest);
  } catch (error) {
    return permanentFailure(error, { provider: "github" });
  }

  return dispatchStandardRequest("github", cred, request, env, options);
}
