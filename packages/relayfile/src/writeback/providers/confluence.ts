import {
  resolveConfluenceDeleteRequest,
  resolveConfluenceWritebackRequest,
} from "@relayfile/adapter-confluence/writeback";
import type {
  DispatchResult,
  IntegrationCredential,
  ProviderDispatchOptions,
  WritebackEnv,
  WritebackInput,
} from "../types.js";
import { dispatchStandardRequest, permanentFailure } from "./common.js";

export async function dispatch(
  input: WritebackInput,
  cred: IntegrationCredential,
  env: WritebackEnv,
  options: ProviderDispatchOptions = {},
): Promise<DispatchResult> {
  try {
    const request =
      input.action === "file_delete"
        ? resolveConfluenceDeleteRequest(input.path)
        : resolveConfluenceWritebackRequest(input.path, input.content);
    return dispatchStandardRequest("confluence", cred, request, env, options);
  } catch (error) {
    return permanentFailure(error, { provider: "confluence" });
  }
}
