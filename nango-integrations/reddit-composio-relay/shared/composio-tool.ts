import {
  executeComposioToolRequest,
  getComposioContext as getSharedComposioContext,
  type ComposioContext,
  type NangoClient,
} from "../../shared/composio-tool.js";

export type { ComposioContext, NangoClient };

export const getComposioContext = async (nango: NangoClient): Promise<ComposioContext> =>
  getSharedComposioContext(nango);

export interface ExecuteComposioToolOptions<TArgs extends Record<string, unknown>> {
  toolSlug: string;
  arguments: TArgs;
  retries?: number;
}

export const executeComposioTool = async <
  TData = unknown,
  TArgs extends Record<string, unknown> = Record<string, unknown>,
>(
  nango: NangoClient,
  ctx: ComposioContext,
  options: ExecuteComposioToolOptions<TArgs>,
): Promise<TData> =>
  executeComposioToolRequest<TData, TArgs>(nango, ctx, {
    toolSlug: options.toolSlug,
    arguments: options.arguments,
    retries: options.retries ?? 2,
  });
