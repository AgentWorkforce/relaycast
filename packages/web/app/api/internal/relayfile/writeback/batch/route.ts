import { NextRequest, NextResponse } from "next/server";
import {
  handleRelayfileProviderWriteback,
  isRelayfileWritebackInput,
  type RelayfileWritebackInput,
} from "../../../../../../lib/integrations/relayfile-writeback-bridge";
import { verifyRelayfileInternalRequest } from "../../../../../../lib/integrations/relayfile-writeback-auth";
import {
  dispatchMovedToCloudflare,
  relayfileWritebackProviderSegment,
} from "../dispatch-moved";

export const runtime = "nodejs";

const BATCH_DISPATCH_CONCURRENCY = 10;

export async function POST(request: NextRequest) {
  let rawBody = "";
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!verifyRelayfileInternalRequest(request.headers, rawBody)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const items = readBatchItems(body);
  if (!items || items.length === 0 || !items.every(isRelayfileWritebackInput)) {
    return NextResponse.json({ error: "Invalid writeback batch payload" }, { status: 400 });
  }

  // Dispatch items with bounded parallelism. Sequential `await` in a for-loop
  // turned a 50-item batch into ~50 × <provider-latency> wall time inside one
  // Lambda, which negated most of the batching win. Unbounded parallelism
  // would spike Nango/provider rate limits and saturate the Node HTTP agent.
  // 10-at-a-time is a sensible middle ground: ~5x the throughput of serial
  // while staying well under typical per-tenant rate limits.
  const handleItem = async (item: RelayfileWritebackInput) => {
    if (await dispatchMovedToCloudflare(item)) {
      return {
        opId: item.opId,
        outcome: "retryable_failure" as const,
        provider: relayfileWritebackProviderName(item),
        error: {
          code: "dispatch_moved",
          message: "Relayfile writeback dispatch moved to Cloudflare",
        },
        relayfileAcked: false,
      };
    }

    return {
      opId: item.opId,
      ...(await handleRelayfileProviderWriteback(item)),
    };
  };

  const settled: PromiseSettledResult<Awaited<ReturnType<typeof handleItem>>>[] = [];
  for (let i = 0; i < items.length; i += BATCH_DISPATCH_CONCURRENCY) {
    const chunk = items.slice(i, i + BATCH_DISPATCH_CONCURRENCY);
    settled.push(...(await Promise.allSettled(chunk.map(handleItem))));
  }

  const results = settled.map((outcome, idx) => {
    if (outcome.status === "fulfilled") {
      return outcome.value;
    }
    const item = items[idx]!;
    const message =
      outcome.reason instanceof Error
        ? outcome.reason.message
        : String(outcome.reason);
    return {
      opId: item.opId,
      outcome: "retryable_failure" as const,
      provider: relayfileWritebackProviderName(item),
      error: {
        code: "handler_threw",
        message,
      },
      relayfileAcked: false,
    };
  });

  return NextResponse.json({ results });
}

function relayfileWritebackProviderName(item: RelayfileWritebackInput): string {
  const requestedProvider = item.provider?.trim();
  return requestedProvider || relayfileWritebackProviderSegment(item.path) || "unknown";
}

function readBatchItems(body: unknown): RelayfileWritebackInput[] | null {
  if (Array.isArray(body)) {
    return body as RelayfileWritebackInput[];
  }
  if (body && typeof body === "object") {
    const items = (body as { items?: unknown }).items;
    if (Array.isArray(items)) {
      return items as RelayfileWritebackInput[];
    }
  }
  return null;
}
