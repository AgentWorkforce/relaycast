import type { SignalBuckets } from "./insight-schema.js";

const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = "openai/gpt-4o-mini";
const SUMMARY_TIMEOUT_MS = 3_000;

type SummaryResult = { summary: string } | { summary: null; reason: string };

interface OpenRouterChatResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
}

export async function summarizeInsight(input: {
  domain: "github" | "linear";
  signals: SignalBuckets;
  metrics: Record<string, number>;
  apiKey: string;
  signal?: AbortSignal;
}): Promise<SummaryResult> {
  if (input.signal?.aborted) {
    return { summary: null, reason: "aborted" };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, SUMMARY_TIMEOUT_MS);
  const abortFromParent = () => controller.abort();
  input.signal?.addEventListener("abort", abortFromParent, { once: true });

  try {
    const response = await globalThis.fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are a morning-standup briefer. Write concise, specific insight summaries for engineering operators.",
          },
          {
            role: "user",
            content: JSON.stringify({
              domain: input.domain,
              signals: input.signals,
              metrics: input.metrics,
              instruction:
                "Summarize what needs attention this morning in <=3 sentences. Be specific, avoid raw counting, and mention the most important blockers first.",
            }),
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return { summary: null, reason: `openrouter returned ${response.status}` };
    }

    const payload = (await response.json().catch(() => null)) as OpenRouterChatResponse | null;
    const summary = payload?.choices?.[0]?.message?.content;
    if (typeof summary !== "string" || !summary.trim()) {
      return { summary: null, reason: "invalid response" };
    }

    return { summary: summary.trim() };
  } catch {
    if (timedOut) {
      return { summary: null, reason: "timed out" };
    }
    if (input.signal?.aborted) {
      return { summary: null, reason: "aborted" };
    }
    return { summary: null, reason: "request failed" };
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abortFromParent);
  }
}
