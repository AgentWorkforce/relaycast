import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
} from "@opentelemetry/api";

const DEFAULT_SERVICE_NAME = "agent-gateway";
const TRACE_PROPAGATOR = propagation;

type GatewayOtelEnv = {
  OTEL_SERVICE_NAME?: string;
  RELAY_OTEL_ENABLED?: string;
  RELAY_OTEL_EXPORTER?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_HEADERS?: string;
  OTEL_EXPORTER_OTLP_TRACES_HEADERS?: string;
};

export function instrumentGatewayWorker<E extends GatewayOtelEnv, Q, C>(
  handler: ExportedHandler<E, Q, C>,
): ExportedHandler<E, Q, C> {
  let wrappedHandlerPromise: Promise<ExportedHandler<E, Q, C>> | null = null;

  return {
    ...handler,
    async fetch(request, env, ctx) {
      wrappedHandlerPromise ??= wrapGatewayHandler(handler);
      const wrappedHandler = await wrappedHandlerPromise;
      if (!wrappedHandler.fetch) {
        throw new Error("instrumented gateway worker does not define a fetch handler");
      }
      return await wrappedHandler.fetch(request, env, ctx);
    },
  };
}

export function instrumentGatewayDurableObject<T extends DurableObjectClass>(
  durableObjectClass: T,
): T {
  return durableObjectClass;
}

export async function withGatewaySpan<T>(
  name: string,
  options: {
    attributes?: Attributes;
    context?: Context;
    kind?: SpanKind;
  },
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return await trace.getTracer(DEFAULT_SERVICE_NAME).startActiveSpan(
    name,
    {
      kind: options.kind ?? SpanKind.INTERNAL,
      ...(options.attributes ? { attributes: options.attributes } : {}),
    },
    options.context ?? context.active(),
    async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        recordSpanError(span, error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

export function injectTraceContextIntoCarrier<T extends Record<string, unknown>>(
  carrier: T,
  sourceContext: Context = context.active(),
): T {
  TRACE_PROPAGATOR.inject(sourceContext, carrier, {
    set(target, key, value) {
      (target as Record<string, string>)[key] = value;
    },
  });
  return carrier;
}

export function extractTraceContextFromCarrier(
  carrier: Record<string, unknown> | null | undefined,
): Context {
  if (!carrier) {
    return ROOT_CONTEXT;
  }

  return TRACE_PROPAGATOR.extract(ROOT_CONTEXT, carrier, {
    get(target, key) {
      const value = target[key];
      if (typeof value === "string" && value.trim()) {
        return value;
      }
      return undefined;
    },
    keys(target) {
      return Object.keys(target);
    },
  });
}

export function injectTraceContextIntoHeaders(
  headers: Headers,
  sourceContext: Context = context.active(),
): Headers {
  TRACE_PROPAGATOR.inject(sourceContext, headers, {
    set(target, key, value) {
      target.set(key, value);
    },
  });
  return headers;
}

export function extractTraceContextFromHeaders(headers: Headers): Context {
  return TRACE_PROPAGATOR.extract(ROOT_CONTEXT, headers, {
    get(target, key) {
      return target.get(key) ?? undefined;
    },
    keys(target) {
      return Array.from(target.keys());
    },
  });
}

export function recordSpanError(span: Span, error: unknown): void {
  if (error instanceof Error) {
    span.recordException(error);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error.message,
    });
    return;
  }

  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: typeof error === "string" ? error : "unknown error",
  });
}

type DurableObjectClass = {
  new (state: DurableObjectState, env: any): DurableObject;
};

function resolveGatewayOtelConfig(
  env: GatewayOtelEnv,
  _trigger: unknown,
) {
  const serviceName =
    env.OTEL_SERVICE_NAME?.trim() || DEFAULT_SERVICE_NAME;

  if (!shouldEnableGatewayOtel(env)) {
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
    },
  };
}

type GatewayInstrumenterModule = {
  instrument: <E extends GatewayOtelEnv, Q, C>(
    handler: ExportedHandler<E, Q, C>,
    config: unknown,
  ) => ExportedHandler<E, Q, C>;
};

async function wrapGatewayHandler<E extends GatewayOtelEnv, Q, C>(
  handler: ExportedHandler<E, Q, C>,
): Promise<ExportedHandler<E, Q, C>> {
  const instrumenter = await loadGatewayInstrumenter();
  if (!instrumenter) {
    return handler;
  }

  return instrumenter.instrument(handler, resolveGatewayOtelConfig);
}

let gatewayInstrumenterPromise: Promise<GatewayInstrumenterModule | null> | null = null;

async function loadGatewayInstrumenter(): Promise<GatewayInstrumenterModule | null> {
  gatewayInstrumenterPromise ??= (async () => {
    try {
      const dynamicImport = new Function(
        "specifier",
        "return import(specifier);",
      ) as (specifier: string) => Promise<GatewayInstrumenterModule>;
      return await dynamicImport("@microlabs/otel-cf-workers");
    } catch {
      return null;
    }
  })();

  return await gatewayInstrumenterPromise;
}

function shouldEnableGatewayOtel(env: GatewayOtelEnv): boolean {
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

function normalizeExporterKind(
  value: string | undefined,
): "none" | "otlp-http" {
  return value?.trim().toLowerCase() === "none" ? "none" : "otlp-http";
}

function parseHeaderList(
  value: string | undefined,
): Record<string, string> | undefined {
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
