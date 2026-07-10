interface CallbackPayload {
  runId: string;
  status: string;
  result?: any;
  error?: string;
}

export interface ReporterOptions {
  callbackUrl: string;
  callbackToken: string;
}

export class Reporter {
  private readonly callbackUrl: string;
  private readonly callbackToken: string;

  constructor({ callbackUrl, callbackToken }: ReporterOptions) {
    this.callbackUrl = callbackUrl;
    this.callbackToken = callbackToken;
  }

  async reportStatus(runId: string, status: string): Promise<void> {
    await this.post({ runId, status });
  }

  async reportCompletion(runId: string, result: any): Promise<void> {
    await this.post({
      runId,
      status: 'completed',
      result,
    });
  }

  async reportError(runId: string, error: Error | string): Promise<void> {
    await this.post({
      runId,
      status: 'failed',
      error: error instanceof Error ? error.message : error,
    });
  }

  private async post(payload: CallbackPayload): Promise<void> {
    const maxAttempts = 3;
    const baseDelayMs = 1000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await globalThis.fetch(this.callbackUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Callback-Token': this.callbackToken,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15_000),
        });

        if (!response.ok) {
          // 4xx errors (e.g. 409 when the run already reached a terminal
          // status) are permanent decisions; the catch block below skips
          // retries for them and surfaces immediately.
          throw new Error(`Callback returned ${response.status}: ${response.statusText}`);
        }

        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const isClientError = /^Callback returned 4\d\d:/.test(message);
        if (isClientError || attempt === maxAttempts) {
          throw new Error(
            `Reporter: failed after ${attempt} attempt${attempt === 1 ? '' : 's'}: ${message}`,
          );
        }

        const delayMs = baseDelayMs * Math.pow(2, attempt - 1); // 1s, 2s, 4s
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
}
