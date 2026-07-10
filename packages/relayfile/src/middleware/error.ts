import type { Context } from "hono";
import type { AppEnv } from "../env.js";

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function getCorrelationId(c: Context<AppEnv>): string {
  return (
    c.get("correlationId") ?? c.req.header("X-Correlation-Id")?.trim() ?? ""
  );
}

export function errorResponse(
  c: Context<AppEnv>,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return c.json(
    {
      code,
      message,
      correlationId: getCorrelationId(c),
      ...(details ? { details } : {}),
    },
    status as never,
  );
}

export function handleNotFound(c: Context<AppEnv>) {
  return errorResponse(c, 404, "not_found", "Route not found");
}

export function handleError(err: unknown, c: Context<AppEnv>) {
  const error =
    err instanceof AppError
      ? err
      : new AppError(
          (err as { status?: number })?.status ?? 500,
          (err as { code?: string })?.code ?? "internal_error",
          err instanceof Error ? err.message : "Internal server error",
          typeof err === "object" && err !== null && "details" in err
            ? ((err as { details?: Record<string, unknown> }).details ??
                undefined)
            : undefined,
        );

  if (error.message.includes("JSON")) {
    return errorResponse(
      c,
      400,
      "invalid_json",
      "Malformed JSON in request body",
    );
  }

  return errorResponse(
    c,
    error.status,
    error.code,
    error.message,
    error.details,
  );
}
