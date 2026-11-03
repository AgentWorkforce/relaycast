/**
 * The deployment routes of the durable-actors control plane
 * (`PUT|GET|DELETE /v1/projects/{project}/deployment`, admin key as a bearer
 * token). Transient failures (5xx, network errors, timeouts) retry with
 * backoff; every other error surfaces with the server's `code`/`message`.
 */
import type { DeploymentRequest } from "./bundle.ts"

export class ControlPlaneError extends Error {
    /** The HTTP status, or 0 when no response arrived. */
    readonly status: number
    readonly code: string

    constructor(status: number, code: string, message: string) {
        super(message)
        this.name = "ControlPlaneError"
        this.status = status
        this.code = code
    }
}

export interface DeploymentClientOptions {
    controlPlaneUrl: string
    projectId: string
    /** The admin key; omitted for a dev control plane without authentication. */
    secret?: string
    fetch?: typeof fetch
    timeoutMs?: number
    retries?: number
    /** Backoff before retry `attempt` (1-based); tests shorten it. */
    delay?: (attempt: number) => Promise<void>
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_RETRIES = 3

function backoff(attempt: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)))
}

export class DeploymentClient {
    private readonly options: DeploymentClientOptions
    private readonly request: typeof fetch
    private readonly timeoutMs: number
    private readonly retries: number
    private readonly delay: (attempt: number) => Promise<void>

    constructor(options: DeploymentClientOptions) {
        this.options = options
        this.request = options.fetch ?? globalThis.fetch
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
        this.retries = options.retries ?? DEFAULT_RETRIES
        this.delay = options.delay ?? backoff
    }

    register(deployment: DeploymentRequest, timeoutMs = this.timeoutMs): Promise<{ changed: boolean }> {
        return this.send("PUT", deployment, timeoutMs) as Promise<{ changed: boolean }>
    }

    current(): Promise<unknown> {
        return this.send("GET", undefined, this.timeoutMs)
    }

    delete(): Promise<{ changed: boolean }> {
        return this.send("DELETE", undefined, this.timeoutMs) as Promise<{ changed: boolean }>
    }

    private url(): string {
        const base = this.options.controlPlaneUrl.replace(/\/+$/, "")
        return `${base}/v1/projects/${encodeURIComponent(this.options.projectId)}/deployment`
    }

    private async send(method: "PUT" | "GET" | "DELETE", body: unknown, timeoutMs: number): Promise<unknown> {
        const headers: Record<string, string> = { accept: "application/json" }
        if (this.options.secret) headers.authorization = `Bearer ${this.options.secret}`
        if (body !== undefined) headers["content-type"] = "application/json"
        const payload = body === undefined ? undefined : JSON.stringify(body)
        for (let attempt = 0; ; attempt++) {
            try {
                const response = await this.request(this.url(), {
                    method,
                    headers,
                    body: payload,
                    signal: AbortSignal.timeout(timeoutMs),
                })
                const text = await response.text()
                if (response.ok) return text ? JSON.parse(text) : {}
                const error = errorFrom(response.status, text)
                if (response.status < 500 || attempt >= this.retries) throw error
            } catch (error) {
                if (error instanceof ControlPlaneError) {
                    if (error.status < 500 || attempt >= this.retries) throw error
                } else if (attempt >= this.retries) {
                    throw new ControlPlaneError(0, "unreachable", `${method} ${this.url()} failed: ${describe(error)}`)
                }
            }
            await this.delay(attempt + 1)
        }
    }
}

function errorFrom(status: number, text: string): ControlPlaneError {
    try {
        const parsed = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } }
        if (parsed && typeof parsed.error?.code === "string" && typeof parsed.error.message === "string")
            return new ControlPlaneError(status, parsed.error.code, parsed.error.message)
    } catch {
        // Not the control plane's error document; report the raw body.
    }
    return new ControlPlaneError(status, `http_${status}`, text.trim() || `HTTP ${status}`)
}

function describe(error: unknown): string {
    if (error instanceof Error) {
        const cause = error.cause instanceof Error ? ` (${error.cause.message})` : ""
        return `${error.name === "TimeoutError" ? "timed out" : error.message}${cause}`
    }
    return String(error)
}
