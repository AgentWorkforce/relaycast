import {
  resolveDeleteRequest as resolveNotionDeleteRequest,
  resolveWritebackRequest,
} from "@relayfile/adapter-notion/writeback";
import {
  DEFAULT_NOTION_API_VERSION,
  type NotionWritebackRequest,
} from "@relayfile/adapter-notion/types";
import { nangoProxy } from "../nango.js";
import type {
  DispatchMetadata,
  DispatchResult,
  IntegrationCredential,
  ProviderDispatchOptions,
  WritebackEnv,
  WritebackInput,
} from "../types.js";
import {
  extractExternalId,
  isRetryableStatus,
  permanentFailure,
  readMessageFromPayload,
  retryableFailure,
  success,
} from "./common.js";

type NotionProxyResponseBody = {
  id?: string | number;
};

export async function dispatch(
  input: WritebackInput,
  cred: IntegrationCredential,
  env: WritebackEnv,
  options: ProviderDispatchOptions = {},
): Promise<DispatchResult> {
  let request: NotionWritebackRequest;
  try {
    request =
      input.action === "file_delete"
        ? resolveNotionDeleteRequest(input.path)
        : resolveWritebackRequest(input.path, input.content);
  } catch (error) {
    return permanentFailure(error, { provider: "notion" });
  }

  const metadata: DispatchMetadata = {
    provider: "notion",
    action: request.action,
    method: request.method,
    endpoint: request.endpoint,
  };

  try {
    const response = await nangoProxy<NotionProxyResponseBody>(
      cred,
      {
        method: request.method,
        endpoint: request.endpoint,
        headers: {
          "Notion-Version":
            request.apiVersion ??
            readNotionApiVersion(cred.aliasFields) ??
            DEFAULT_NOTION_API_VERSION,
        },
        data: request.body,
      },
      env,
      options,
    );
    const externalId = extractExternalId(response.data);
    const responseMetadata = {
      ...metadata,
      status: response.status,
      ...(externalId ? { externalId } : {}),
    };
    if (response.ok) {
      return success(responseMetadata, externalId);
    }
    const message = readMessageFromPayload(
      response.data,
      `Notion writeback failed with status ${response.status}`,
    );
    return isRetryableStatus(response.status)
      ? retryableFailure(message, responseMetadata)
      : permanentFailure(message, responseMetadata);
  } catch (error) {
    return retryableFailure(error, metadata);
  }
}

function readNotionApiVersion(
  aliasFields: Record<string, unknown>,
): string | undefined {
  const value = aliasFields.notionApiVersion;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
