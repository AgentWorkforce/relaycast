import type {
  HarnessToolCall,
  HarnessToolExecutionContext,
  HarnessToolRegistry,
  HarnessToolResult,
} from '@agent-assistant/harness';

/**
 * Wraps a HarnessToolRegistry with unconditional console logging of every
 * tool execution. Each call emits a single line before and after with the
 * turn ID, iteration, tool name, input-key names (not values, to avoid
 * leaking secrets), result status, and duration.
 *
 * Added during the 2026-04-24 specialist incident where the harness was
 * hitting `max_iterations_reached` silently — no signal on WHICH tools
 * the model was choosing, what they returned, or whether they were
 * errored-but-retried. Without this, debugging required adding
 * one-off console.log calls to every tool adapter.
 *
 * Stays on in prod. Output is small (one line in + one out per tool
 * call, times ~6 iterations per turn) and it tells operators what the
 * specialist actually did inside a turn.
 */
export function wrapToolRegistryWithTrace(
  inner: HarnessToolRegistry,
  specialistName: string,
): HarnessToolRegistry {
  return {
    listAvailable: (input) => inner.listAvailable(input),
    async execute(
      call: HarnessToolCall,
      context: HarnessToolExecutionContext,
    ): Promise<HarnessToolResult> {
      const inputKeys = Object.keys(call.input ?? {});
      const startedAt = Date.now();
      console.log('[specialist/tool] call', {
        specialist: specialistName,
        turnId: context.turnId,
        iteration: context.iteration,
        toolCallIndex: context.toolCallIndex,
        tool: call.name,
        callId: call.id,
        inputKeys,
      });
      try {
        const result = await inner.execute(call, context);
        const durationMs = Date.now() - startedAt;
        const outputLength =
          typeof result.output === 'string' ? result.output.length : 0;
        const structuredKeys = result.structuredOutput
          ? Object.keys(result.structuredOutput)
          : [];
        console.log('[specialist/tool] result', {
          specialist: specialistName,
          turnId: context.turnId,
          iteration: context.iteration,
          tool: call.name,
          callId: call.id,
          status: result.status,
          durationMs,
          outputLength,
          structuredKeys,
          ...(result.error
            ? {
                errorCode: result.error.code,
                errorMessagePreview:
                  typeof result.error.message === 'string'
                    ? result.error.message.slice(0, 240)
                    : undefined,
              }
            : {}),
        });
        return result;
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        console.error('[specialist/tool] threw', {
          specialist: specialistName,
          turnId: context.turnId,
          iteration: context.iteration,
          tool: call.name,
          callId: call.id,
          durationMs,
          errorName:
            error instanceof Error ? error.constructor.name : typeof error,
          errorMessage:
            error instanceof Error
              ? error.message.slice(0, 500)
              : String(error).slice(0, 500),
        });
        throw error;
      }
    },
  };
}
