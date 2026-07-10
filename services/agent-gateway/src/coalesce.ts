type PendingTask = {
  run: () => Promise<void> | void;
  timer: ReturnType<typeof setTimeout>;
};

export class EventCoalescer {
  constructor(
    private readonly onError: (key: string, error: unknown) => void = () => {},
  ) {}

  private readonly pending = new Map<string, PendingTask>();

  schedule(
    key: string,
    delayMs: number,
    run: () => Promise<void> | void,
  ): void {
    const existing = this.pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const timer = setTimeout(() => {
      this.pending.delete(key);
      void Promise.resolve()
        .then(run)
        .catch((error) => this.onError(key, error));
    }, Math.max(0, Math.floor(delayMs)));

    this.pending.set(key, { run, timer });
  }

  clear(key: string): void {
    const pending = this.pending.get(key);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(key);
  }

  clearAll(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
    }
    this.pending.clear();
  }
}
