import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { logger } from "@/lib/logger";
import { markupOnly } from "./markup";
import { estimateUsageCostUsdMicros, type TokenUsage } from "./provider-rates";

const SOFT_CAP_USD_MICROS = 100_000_000n;

type RecordHarnessSpendInput = TokenUsage & {
  providerCredentialId: string;
  modelProvider: string;
  authType: string;
  userId: string;
  agentId?: string | null;
  runId?: string | null;
  occurredAt?: Date;
};

type RawRows<T> = { rows?: T[] };

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray((result as RawRows<T>)?.rows) ? (result as RawRows<T>).rows! : [];
}

function safeTokenCount(value: number | undefined): number {
  return Number.isFinite(value) && value && value > 0 ? Math.floor(value) : 0;
}

export async function recordHarnessSpendEvent(input: RecordHarnessSpendInput): Promise<{
  costUsdMicros: bigint;
  markupUsdMicros: bigint;
}> {
  const costUsdMicros = estimateUsageCostUsdMicros(input.modelProvider, input);
  const markupUsdMicros = input.authType === "relay_managed" ? markupOnly(costUsdMicros) : 0n;
  const occurredAt = input.occurredAt ?? new Date();

  await getDb().execute(sql`
    INSERT INTO harness_spend_events (
      provider_credential_id,
      occurred_at,
      model,
      input_tokens,
      output_tokens,
      cache_read_tokens,
      cache_write_tokens,
      cost_usd_micros,
      markup_usd_micros,
      user_id,
      agent_id,
      run_id
    )
    VALUES (
      ${input.providerCredentialId},
      ${occurredAt},
      ${input.model},
      ${safeTokenCount(input.inputTokens)},
      ${safeTokenCount(input.outputTokens)},
      ${safeTokenCount(input.cacheReadTokens)},
      ${safeTokenCount(input.cacheWriteTokens)},
      ${costUsdMicros},
      ${markupUsdMicros},
      ${input.userId},
      ${input.agentId ?? null},
      ${input.runId ?? null}
    )
  `);

  const monthStart = new Date(Date.UTC(occurredAt.getUTCFullYear(), occurredAt.getUTCMonth(), 1));
  const nextMonthStart = new Date(Date.UTC(occurredAt.getUTCFullYear(), occurredAt.getUTCMonth() + 1, 1));
  // TODO: cache or batch this soft-cap check once usage volume grows beyond v1 customer scale.
  const spend = await getDb().execute(sql`
    SELECT COALESCE(SUM(cost_usd_micros + markup_usd_micros), 0)::text AS total
    FROM harness_spend_events
    WHERE user_id = ${input.userId}
      AND occurred_at >= ${monthStart}
      AND occurred_at < ${nextMonthStart}
  `);
  const total = BigInt(rowsOf<{ total: string }>(spend)[0]?.total ?? "0");
  if (total > SOFT_CAP_USD_MICROS) {
    await logger.warn("Harness monthly spend soft cap exceeded", {
      area: "billing-soft-cap",
      userId: input.userId,
      currentSpendUsdMicros: total.toString(),
    });
  }

  return { costUsdMicros, markupUsdMicros };
}
