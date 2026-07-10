import {
  createHarness,
  type HarnessLimits,
  type HarnessModelAdapter,
  type HarnessResult,
  type HarnessToolRegistry,
} from "@agent-assistant/harness";
import type {
  DelegationRequest,
  GitHubCapabilityParams,
  LinearEnumerationParams,
  SpecialistFinding,
  SpecialistFindings,
} from "@agent-assistant/specialists";

import type { A2AAgentCard } from "./agent-card.js";

const DEFAULT_TIMEOUT_MS = 45_000;
const LOG_PREFIX = "[specialist/agentic]";

/**
 * Gate verbose specialist-internals logs behind an env flag so we don't
 * flood production observability when nothing is wrong. Set
 * `DEBUG_SPECIALIST=true` on the specialist-worker Cloudflare binding to
 * enable (see infra/specialist-worker.ts for the wiring).
 *
 * Bindings on Cloudflare Workers land on the handler `env` argument, NOT
 * `globalThis.process.env`. The prior implementation read from process.env
 * and the gate was always false in prod regardless of what operators set
 * on the binding. Callers must forward the bindings record.
 */
type DebugSpecialistBindings = { DEBUG_SPECIALIST?: string } | undefined;

function isDebugSpecialistEnabled(bindings: DebugSpecialistBindings): boolean {
  return bindings?.DEBUG_SPECIALIST === "true";
}

function debugLog(bindings: DebugSpecialistBindings, message: string, payload: Record<string, unknown>): void {
  if (isDebugSpecialistEnabled(bindings)) {
    console.log(LOG_PREFIX, message, payload);
  }
}

type AgenticCapabilityParams = GitHubCapabilityParams | LinearEnumerationParams;
type AgenticDelegationRequestFor<TParams extends AgenticCapabilityParams> = {
  requestId: string;
  workspaceId?: string;
  capability: TParams["capability"];
  params: TParams;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
};
type AgenticDelegationRequest =
  | DelegationRequest
  | AgenticDelegationRequestFor<AgenticCapabilityParams>;
type AgenticSpecialistFindingsFor<TParams extends AgenticCapabilityParams> = {
  requestId: string;
  capability: TParams["capability"];
  status: SpecialistFindings["status"];
  summary: string;
  findings: SpecialistFinding[];
  confidence?: number;
  metadata?: Record<string, unknown>;
};
type AgenticSpecialistFindings =
  AgenticSpecialistFindingsFor<AgenticCapabilityParams>;
type AgenticDelegationTransport<TParams extends AgenticCapabilityParams> = {
  delegate<P extends TParams>(
    request: AgenticDelegationRequestFor<P>,
  ): Promise<AgenticSpecialistFindingsFor<P>>;
};

export interface AgenticSpecialistOptions {
  name: string;
  version: string;
  card: A2AAgentCard;
  systemPrompt: string;
  tools: HarnessToolRegistry;
  model: HarnessModelAdapter;
  limits?: Partial<HarnessLimits>;
  /** Model time budget per delegation (ms). Separate from harness limits. */
  timeoutMs?: number;
  /**
   * Forward the Worker `DEBUG_SPECIALIST` binding from the handler. The
   * AgenticSpecialist factory closes over this value so transport.delegate
   * can emit diagnostics without plumbing bindings through every call.
   */
  debugSpecialist?: string;
}

export interface AgenticSpecialist<TParams extends AgenticCapabilityParams = GitHubCapabilityParams> {
  card: A2AAgentCard;
  transport: AgenticDelegationTransport<TParams>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSpecialistStatus(value: unknown): value is SpecialistFindings["status"] {
  return value === "complete" || value === "partial" || value === "failed";
}

function isSpecialistFinding(value: unknown): value is SpecialistFinding {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    (value.body === undefined || typeof value.body === "string") &&
    (value.url === undefined || typeof value.url === "string") &&
    (value.metadata === undefined || isRecord(value.metadata))
  );
}

/**
 * Shape we accept from the model. requestId + capability are NOT required from
 * the model — we stamp them authoritatively from the DelegationRequest. The
 * model only needs to emit status + summary + findings (+ optional confidence +
 * metadata). This matches the curated prompts and avoids silently discarding
 * otherwise-valid structured output just because the model forgot to echo the
 * request id.
 */
function isParsedSpecialistOutput(value: unknown): value is {
  status?: unknown;
  summary: string;
  findings: SpecialistFinding[];
  confidence?: number;
  metadata?: Record<string, unknown>;
} {
  return (
    isRecord(value) &&
    typeof value.summary === "string" &&
    Array.isArray(value.findings) &&
    value.findings.every(isSpecialistFinding) &&
    (value.confidence === undefined ||
      (typeof value.confidence === "number" && Number.isFinite(value.confidence))) &&
    (value.metadata === undefined || isRecord(value.metadata))
  );
}

function deriveQuery(request: AgenticDelegationRequest): string {
  const query = request.params?.query;
  if (typeof query === "string") {
    return query;
  }
  return JSON.stringify(request.params ?? {}) ?? "{}";
}

function renderDeveloperPrompt(request: AgenticDelegationRequest): string {
  return [
    "Delegation request:",
    "```json",
    JSON.stringify(
      {
        requestId: request.requestId,
        capability: request.capability,
        params: request.params,
        timeoutMs: request.timeoutMs,
        metadata: request.metadata,
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

function extractLeadingJsonBlock(text: string): string | null {
  const match = /^```json\s*([\s\S]*?)\s*```/i.exec(text.trimStart());
  return match?.[1] ?? null;
}

function fallbackFindings(
  text: string,
  request: AgenticDelegationRequest,
): AgenticSpecialistFindings {
  return {
    requestId: request.requestId,
    capability: request.capability,
    status: "complete",
    summary: text.trim().slice(0, 500),
    findings: [],
  };
}

function parseFindings(
  text: string,
  request: AgenticDelegationRequest,
): AgenticSpecialistFindings {
  const jsonBlock = extractLeadingJsonBlock(text);
  if (jsonBlock !== null) {
    try {
      const parsed: unknown = JSON.parse(jsonBlock);
      if (isParsedSpecialistOutput(parsed)) {
        // Always stamp requestId + capability from the delegation request. The
        // prompt doesn't require the model to emit them, and if it does we
        // ignore it to avoid trusting an echoed but mismatched value.
        const status = isSpecialistStatus(parsed.status) ? parsed.status : "complete";
        return {
          requestId: request.requestId,
          capability: request.capability,
          status,
          summary: parsed.summary,
          findings: parsed.findings,
          ...(parsed.confidence !== undefined ? { confidence: parsed.confidence } : {}),
          ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}),
        } satisfies AgenticSpecialistFindings;
      }
    } catch {
      // Fall through and preserve the model text as a plain summary.
    }
  }

  return fallbackFindings(text, request);
}

function addSpecialistMetadata(
  findings: AgenticSpecialistFindings,
  options: Pick<AgenticSpecialistOptions, "name" | "version">,
): AgenticSpecialistFindings {
  return {
    ...findings,
    metadata: {
      ...(findings.metadata ?? {}),
      specialistName: options.name,
      version: options.version,
    },
  };
}

function failedFindings(
  request: AgenticDelegationRequest,
  result: HarnessResult,
  options: Pick<AgenticSpecialistOptions, "name" | "version">,
  lastInvalidReason: string | undefined,
): AgenticSpecialistFindings {
  const reasonSuffix = lastInvalidReason ? ` (${lastInvalidReason})` : "";
  const metadata: Record<string, unknown> = {
    specialistName: options.name,
    version: options.version,
    outcome: result.outcome,
    stopReason: result.stopReason,
  };
  if (result.metadata && typeof result.metadata === "object") {
    metadata.harnessMetadata = result.metadata;
  }
  if (lastInvalidReason) {
    metadata.lastInvalidModelOutputReason = lastInvalidReason;
  }
  return {
    requestId: request.requestId,
    capability: request.capability,
    status: "failed",
    summary: `specialist agent did not complete: ${result.stopReason ?? result.outcome}${reasonSuffix}`,
    findings: [],
    confidence: 0,
    metadata,
  };
}

export function createAgenticSpecialist<
  TParams extends AgenticCapabilityParams = GitHubCapabilityParams,
>(
  options: AgenticSpecialistOptions,
): AgenticSpecialist<TParams> {
  // Captures the most recent `invalid` model output reason seen during
  // this specialist's lifetime so the final failed-findings response can
  // include WHY the model output was rejected (OpenRouter HTTP error,
  // tool-call JSON parse failure, timeout, empty content, etc.). Mutated
  // by the onInvalidModelOutput hook below and read once by the transport.
  //
  // The hook also logs the reason unconditionally — we intentionally do
  // not gate this behind DEBUG_SPECIALIST because this is the single
  // signal that tells operators whether to fix the model/prompt, the
  // upstream API, or the adapter. Without it, `stopReason:
  // "model_invalid_response"` is opaque.
  let lastInvalidReason: string | undefined;
  const harness = createHarness({
    model: options.model,
    tools: options.tools,
    limits: {
      maxIterations: 6,
      maxToolCalls: 10,
      maxElapsedMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...options.limits,
    },
    hooks: {
      onInvalidModelOutput: (output) => {
        const reason = typeof output?.reason === "string" && output.reason.trim().length > 0
          ? output.reason
          : "unspecified";
        lastInvalidReason = reason;
        const rawExcerpt = output?.raw
          ? JSON.stringify(output.raw).slice(0, 500)
          : undefined;
        console.error("[specialist/agentic] invalid model output", {
          specialist: options.name,
          reason,
          ...(rawExcerpt ? { rawExcerpt } : {}),
        });
      },
      // Log a compact summary whenever a turn ends with anything other
      // than a clean answer. Unconditional (not DEBUG_SPECIALIST-gated)
      // because the alternative is flying blind when the harness caps
      // at `max_iterations_reached` — added during the 2026-04-24
      // incident where that was exactly the next failure state after
      // fetch dispatch was fixed.
      onTurnFinished: (result, state) => {
        if (result.outcome === "completed") return;
        const transcriptSummary = state?.transcript?.map((step) => {
          if (step.type === "tool_result") {
            return {
              kind: "tool",
              iteration: step.iteration,
              name: step.result?.toolName,
              status: step.result?.status,
              outputLength:
                typeof step.result?.output === "string"
                  ? step.result.output.length
                  : 0,
            };
          }
          if (step.type === "assistant_step") {
            const preview =
              typeof step.text === "string" ? step.text.slice(0, 200) : "";
            return {
              kind: "assistant",
              iteration: step.iteration,
              outputType: step.outputType,
              preview,
            };
          }
          return { kind: step.type };
        }) ?? [];
        console.warn("[specialist/agentic] turn did not complete", {
          specialist: options.name,
          outcome: result.outcome,
          stopReason: result.stopReason,
          iterations: state?.iteration ?? null,
          toolCallCount: state?.toolCallCount ?? null,
          elapsedMs: state?.elapsedMs ?? null,
          transcript: transcriptSummary,
          assistantMessagePreview:
            typeof result.assistantMessage?.text === "string"
              ? result.assistantMessage.text.slice(0, 400)
              : null,
        });
      },
    },
  });

  const transport: AgenticDelegationTransport<AgenticCapabilityParams> = {
    async delegate<P extends AgenticCapabilityParams>(
      request: AgenticDelegationRequestFor<P>,
    ): Promise<AgenticSpecialistFindingsFor<P>> {
      const now = new Date().toISOString();
      const debugBindings = { DEBUG_SPECIALIST: options.debugSpecialist };
      debugLog(debugBindings, "delegate start", {
        specialist: options.name,
        requestId: request.requestId,
        capability: request.capability,
        workspaceId: request.workspaceId,
        query: deriveQuery(request),
      });
      const result = await harness.runTurn({
        assistantId: options.name,
        turnId: request.requestId,
        message: {
          id: request.requestId,
          text: deriveQuery(request),
          receivedAt: now,
        },
        instructions: {
          systemPrompt: options.systemPrompt,
          developerPrompt: renderDeveloperPrompt(request),
        },
      });

      const findings =
        result.outcome === "completed"
          ? addSpecialistMetadata(
              parseFindings(result.assistantMessage?.text ?? "", request),
              options,
            )
          : failedFindings(request, result, options, lastInvalidReason);
      // Reset between delegations so a later successful turn's findings
      // aren't annotated with a stale reason from a prior failure.
      lastInvalidReason = undefined;

      debugLog(debugBindings, "delegate done", {
        specialist: options.name,
        requestId: request.requestId,
        capability: request.capability,
        harnessOutcome: result.outcome,
        harnessStopReason: result.stopReason,
        findingsStatus: findings.status,
        findingsCount: findings.findings.length,
        assistantTextLength: result.assistantMessage?.text?.length ?? 0,
        summaryPreview: findings.summary.slice(0, 240),
      });

      return findings as AgenticSpecialistFindingsFor<P>;
    },
  };

  return {
    card: options.card,
    transport: transport as AgenticDelegationTransport<TParams>,
  };
}
