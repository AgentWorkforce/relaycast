import type { NangoSync, NangoAction, ProxyConfiguration } from "nango";
import { VERBOSE_LOGGING } from "../global-config.js";

export type NotionRequestHook = () => Promise<void>;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const createRequestThrottle = (intervalMs: number): NotionRequestHook => {
  let nextRequestAt = 0;
  let queue = Promise.resolve();

  return async () => {
    const waitForTurn = queue.then(async () => {
      const now = Date.now();
      const waitMs = Math.max(0, nextRequestAt - now);

      if (waitMs > 0) {
        await sleep(waitMs);
      }

      nextRequestAt = Date.now() + intervalMs;
    });

    queue = waitForTurn.catch(() => {});
    await waitForTurn;
  };
};

export const serialize = (value: any) => {
  return value === null || value === undefined ? "" : String(value);
};

export const defaultStringLength = (value: any) => {
  return value.length;
};

export const toAlignment = (value: any) => {
  const code = typeof value === "string" ? value.codePointAt(0) : 0;

  return code === 67 /* `C` */ || code === 99 /* `c` */
    ? 99 /* `c` */
    : code === 76 /* `L` */ || code === 108 /* `l` */
      ? 108 /* `l` */
      : code === 82 /* `R` */ || code === 114 /* `r` */
        ? 114 /* `r` */
        : 0;
};

export const fetchBlocks = async (
  nango: NangoSync | NangoAction,
  id: string,
  options: { beforeRequest?: NotionRequestHook } = {},
) => {
  return paginate(
    nango,
    "get",
    `/v1/blocks/${id}/children`,
    "Notion blocks",
    100,
    false,
    options.beforeRequest,
  );
};

export const paginate = async (
  nango: NangoSync | NangoAction,
  method: "get" | "post",
  endpoint: string,
  desc: string,
  pageSize = 100,
  incremental = false,
  beforeRequest?: NotionRequestHook,
) => {
  let cursor: string | undefined;
  let pageCounter = 0;
  let results: any[] = [];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (VERBOSE_LOGGING) {
      await nango.log(
        `Fetching ${desc} ${pageCounter * pageSize + 1} to ${++pageCounter * pageSize}`,
      );
    }

    const postData: Record<string, number | string | Record<string, string>> = {
      page_size: pageSize,
    };

    if (cursor) {
      postData["start_cursor"] = cursor;
    }

    if (incremental && isNangoSync(nango) && nango.lastSyncDate) {
      postData["sort"] = {
        direction: "ascending",
        timestamp: "last_edited_time",
      };
    }

    const config: ProxyConfiguration = {
      method,
      endpoint,
      data: method === "post" ? postData : {},
      params:
        method === "get"
          ? {
              page_size: `${pageSize}`,
              ...(cursor !== undefined ? { start_cursor: cursor } : {}),
            }
          : {},
      retries: 10, // Exponential backoff + long-running job = handles rate limits well.
    };

    if (VERBOSE_LOGGING) {
      await nango.log(
        `Fetching ${desc} with config: ${JSON.stringify(config, null, 2)}`,
      );
    }

    try {
      if (beforeRequest) {
        await beforeRequest();
      }

      const res = await nango.proxy(config);

      if (
        incremental &&
        isNangoSync(nango) &&
        nango.lastSyncDate &&
        res.data.results.length &&
        new Date(
          res.data.results[res.data.results.length - 1].last_edited_time,
        ) < nango.lastSyncDate
      ) {
        results = results.concat(
          res.data.results.filter(
            (result: any) =>
              new Date(result.last_edited_time) >= nango.lastSyncDate!,
          ),
        );
        break;
      } else {
        results = results.concat(res.data.results);
      }

      if (!res.data.has_more || !res.data.next_cursor) {
        break;
      } else {
        cursor = res.data.next_cursor;
      }
    } catch (e: any) {
      const response = e.response;
      if (
        response?.data &&
        response.data.status === 400 &&
        response.data.code === "validation_error" &&
        response.data.message ===
          "Block type external_object_instance_page is not supported via the API."
      ) {
        if (VERBOSE_LOGGING) {
          await nango.log(
            `Skipping unsupported block type external_object_instance_page for ${config.endpoint}`,
            { level: "warn" },
          );
        }
        break;
      } else if (
        response?.data &&
        response.data.status === 404 &&
        response.data.code === "object_not_found"
      ) {
        if (VERBOSE_LOGGING) {
          await nango.log(
            `Object was not found, skipping. The endpoint was ${config.endpoint}`,
            { level: "error" },
          );
        }
        break;
      } else {
        // Extract error details as primitives to avoid AxiosError bubbling up
        const statusCode = response?.status ?? e.status ?? "unknown";
        const errorCode = response?.data?.code ?? e.code;
        const errorMessage =
          response?.data?.message ?? e.message ?? "Unknown error";

        await nango.log(
          `Error fetching ${desc} from ${config.endpoint}: ${errorMessage} (status: ${statusCode}, code: ${errorCode})`,
          { level: "error" },
        );

        throw new Error(
          `Failed to fetch ${desc}: ${errorMessage} (HTTP ${statusCode})`,
        );
      }
    }
  }

  return results;
};

// Type guard to check if nango is of type NangoSync
function isNangoSync(nango: NangoSync | NangoAction): nango is NangoSync {
  return (nango as NangoSync).lastSyncDate !== undefined;
}
