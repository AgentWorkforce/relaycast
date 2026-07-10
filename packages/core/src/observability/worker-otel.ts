type WorkerOtelEnv = {
  OTEL_SERVICE_NAME?: string;
  RELAY_OTEL_ENABLED?: string;
  RELAY_OTEL_EXPORTER?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_HEADERS?: string;
  OTEL_EXPORTER_OTLP_TRACES_HEADERS?: string;
};

type WorkerHandlerLike = {
  fetch?: (request: Request, env: any, ctx: any) => Promise<Response> | Response;
  queue?: (batch: any, env: any, ctx: any) => Promise<void> | void;
  [key: string]: unknown;
};

type WorkerInstrumenterModule = {
  instrument: <H extends WorkerHandlerLike>(
    handler: H,
    config: unknown,
  ) => H;
};

type InstrumentWorkerOptions = {
  serviceName: string;
};

export function instrumentWorker<H extends WorkerHandlerLike>(
  handler: H,
  options: InstrumentWorkerOptions,
): H {
  let wrappedHandlerPromise: Promise<H> | null = null;

  async function wrappedHandler(): Promise<H> {
    wrappedHandlerPromise ??= wrapWorkerHandler(handler, options);
    return await wrappedHandlerPromise;
  }

  return {
    ...handler,
    async fetch(request, env, ctx) {
      const wrapped = await wrappedHandler();
      if (!wrapped.fetch) {
        throw new Error("instrumented worker does not define a fetch handler");
      }
      return await wrapped.fetch(request, env, ctx);
    },
    async queue(batch, env, ctx) {
      const wrapped = await wrappedHandler();
      if (!wrapped.queue) {
        return;
      }
      await wrapped.queue(batch, env, ctx);
    },
  } as H;
}

function resolveWorkerOtelConfig(
  options: InstrumentWorkerOptions,
) {
  return (env: WorkerOtelEnv) => {
    const serviceName =
      env.OTEL_SERVICE_NAME?.trim() || options.serviceName;

    if (!shouldEnableWorkerOtel(env)) {
      return {
        service: { name: serviceName },
        spanProcessors: [],
        fetch: {
          includeTraceContext: true,
        },
        handlers: {
          fetch: {
            acceptTraceContext: true,
          },
          queue: {},
        },
      };
    }

    return {
      service: { name: serviceName },
      exporter: {
        url:
          env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim()
          || env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()
          || "http://127.0.0.1:4318/v1/traces",
        headers:
          parseHeaderList(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS)
          ?? parseHeaderList(env.OTEL_EXPORTER_OTLP_HEADERS)
          ?? {},
      },
      fetch: {
        includeTraceContext: true,
      },
      handlers: {
        fetch: {
          acceptTraceContext: true,
        },
        queue: {},
      },
    };
  };
}

async function wrapWorkerHandler<H extends WorkerHandlerLike>(
  handler: H,
  options: InstrumentWorkerOptions,
): Promise<H> {
  const instrumenter = await loadWorkerInstrumenter();
  if (!instrumenter) {
    return handler;
  }

  try {
    return instrumenter.instrument(handler, resolveWorkerOtelConfig(options));
  } catch {
    return handler;
  }
}

let workerInstrumenterPromise: Promise<WorkerInstrumenterModule | null> | null = null;

async function loadWorkerInstrumenter(): Promise<WorkerInstrumenterModule | null> {
  workerInstrumenterPromise ??= (async () => {
    try {
      const dynamicImport = new Function(
        "specifier",
        "return import(specifier);",
      ) as (specifier: string) => Promise<WorkerInstrumenterModule>;
      return await dynamicImport("@microlabs/otel-cf-workers");
    } catch {
      return null;
    }
  })();

  return await workerInstrumenterPromise;
}

function shouldEnableWorkerOtel(env: WorkerOtelEnv): boolean {
  if (isExplicitlyFalse(env.RELAY_OTEL_ENABLED)) {
    return false;
  }

  if (normalizeExporterKind(env.RELAY_OTEL_EXPORTER) === "none") {
    return false;
  }

  if (isExplicitlyTrue(env.RELAY_OTEL_ENABLED)) {
    return true;
  }

  return Boolean(
    env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim()
      || env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()
      || env.OTEL_EXPORTER_OTLP_TRACES_HEADERS?.trim()
      || env.OTEL_EXPORTER_OTLP_HEADERS?.trim(),
  );
}

function normalizeExporterKind(value: string | undefined): "none" | "otlp-http" {
  return value?.trim().toLowerCase() === "none" ? "none" : "otlp-http";
}

function parseHeaderList(value: string | undefined): Record<string, string> | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separatorIndex = entry.indexOf("=");
      if (separatorIndex < 0) {
        return null;
      }

      const key = entry.slice(0, separatorIndex).trim();
      const headerValue = entry.slice(separatorIndex + 1).trim();
      if (!key || !headerValue) {
        return null;
      }

      return [key, headerValue] as const;
    })
    .filter((entry): entry is readonly [string, string] => Boolean(entry));

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function isExplicitlyTrue(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}

function isExplicitlyFalse(value: string | undefined): boolean {
  return /^(0|false|no|off)$/i.test(value?.trim() ?? "");
}
