import { Actor, Ephemeral, type ActorContext, type ActorSocket } from "durable-actors"
import {
    actorConfigFromEnv,
    createActorRuntime,
    type ActorEngineConfig,
    type ActorHttpRequest,
    type ActorHttpResponse,
    type ActorRuntime,
} from "@relaycast/engine/adapters/actor"

/** What the actor reads from its environment besides the engine config. */
export interface WorkspaceEnvConfig {
    /** Public origin clients reach the gateway on; signed file URLs point at its `/_relayfiles`. */
    publicUrl: string
    /** HMAC secret shared with the gateway that serves `/_relayfiles`. */
    fileSigningSecret: string
    engine: ActorEngineConfig
}

/**
 * The actor's configuration from `env`: `RELAYCAST_PUBLIC_URL` and
 * `RELAYCAST_FILE_SIGNING_SECRET` are required; the engine variables
 * (`RELAYCAST_MAX_UPLOAD_BYTES`, `RELAYCAST_MESSAGE_TTL_DAYS`,
 * `RELAYCAST_MAILBOX_*`, `RELAYCAST_RATE_LIMIT_PER_MINUTE`,
 * `RELAYCAST_INTERNAL_SECRET`, `RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET` (or
 * `_FILE`), `RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED`, `RELAYCAST_ENV`)
 * are read by the engine with the self-host server's semantics. Throws on a
 * missing or invalid value.
 */
export function workspaceConfigFromEnv(env: Record<string, string | undefined>): WorkspaceEnvConfig {
    return {
        publicUrl: httpOrigin("RELAYCAST_PUBLIC_URL", requiredEnv(env, "RELAYCAST_PUBLIC_URL")),
        fileSigningSecret: requiredEnv(env, "RELAYCAST_FILE_SIGNING_SECRET", MIN_FILE_SIGNING_SECRET_LENGTH),
        engine: actorConfigFromEnv(env),
    }
}

/** The floor the gateway enforces on the same secret (`openssl rand -hex 32` gives 64). */
export const MIN_FILE_SIGNING_SECRET_LENGTH = 32

function requiredEnv(env: Record<string, string | undefined>, name: string, minLength = 1): string {
    const value = env[name]?.trim()
    if (!value) throw new Error(`${name} is not set`)
    if (value.length < minLength) throw new Error(`${name} must be at least ${minLength} characters`)
    return value
}

/**
 * An http(s) origin, normalized (`https://relay.example.com/` → no trailing
 * slash). Signed file URLs are `<origin>/_relayfiles?token=…` and the gateway
 * serves exactly that path, so a path, query, fragment or credentials in the
 * value would make every file URL miss.
 */
function httpOrigin(name: string, value: string): string {
    let url: URL
    try {
        url = new URL(value)
    } catch {
        throw new Error(`${name} must be an absolute http(s) URL`)
    }
    if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
        throw new Error(`${name} must be an http(s) origin without credentials, path, query or fragment`)
    }
    return url.origin
}

/**
 * One relaycast workspace per actor: the actor id is the workspace id, and the
 * engine runs on the actor's SQLite. The gateway (`@relaycast/actors-gateway`)
 * calls `create` for `POST /v1/workspaces` and `handle` for everything else,
 * routing by the workspace id inside each `ar_` credential. A WebSocket
 * upgrade (`/v1/ws`, `/v1/node/ws`) answers with a socket grant; the gateway
 * opens an actor socket with the grant's principal as metadata, and the
 * engine's realtime runs over the socket lifecycle hooks below.
 *
 * durable-actors 0.14.6 saves each SQL write as it happens and keeps the
 * writes made before a thrown error, so each method body runs in
 * `this.db.transaction`: a call that throws rolls back as a whole, and the
 * engine's write groups nest inside it (a failed group rolls back alone and
 * the request goes on, as on the Node adapter). A request the engine answers
 * with an error status is a completed call and commits like any other. The
 * constructor only builds the runtime and runs no SQL: the engine schema is
 * applied inside the first call, so it commits once with that call (and a
 * failed `create` leaves no half-built actor), and a later activation only
 * reads to confirm it.
 */
export class Workspace extends Actor {
    @Ephemeral private runtime: ActorRuntime

    constructor(context: ActorContext) {
        super(context)
        const config = workspaceConfigFromEnv(process.env)
        this.runtime = createActorRuntime({
            sql: this.db,
            workspaceId: this.id,
            baseUrl: config.publicUrl,
            fileSigningSecret: config.fileSigningSecret,
            outboundFetch: (input, init) => globalThis.fetch(input, init),
            alarm: this.alarm,
            // Bound here: the runtime uses them only inside the calls below.
            sockets: {
                getConnections: (tag) => this.getConnections(tag),
                broadcast: (message, options) => this.broadcast(message as never, options),
            },
            config: config.engine,
            // Engine errors and alerts (e.g. alert: "maintenance_rolled_back") go to the actor's log.
            telemetry: {
                capture() {},
                captureException: (error, context) => console.error("relaycast", JSON.stringify(context ?? {}), error),
            },
        })
    }

    /** `POST /v1/workspaces`, with the tag the gateway's keyring signed for this id. */
    async create(request: ActorHttpRequest, credentialTag: string): Promise<ActorHttpResponse> {
        return this.db.transaction(() => this.runtime.create(request, credentialTag))
    }

    async handle(request: ActorHttpRequest): Promise<ActorHttpResponse> {
        return this.db.transaction(() => this.runtime.handle(request))
    }

    /** Outbound HTTP (webhooks, http_push, A2A egress) and maintenance run here, never inside a request. */
    async onAlarm(): Promise<void> {
        await this.db.transaction(() => this.runtime.maintain())
    }

    /** A socket the gateway opened with a grant; its metadata is the grant's principal. */
    async onConnect(socket: ActorSocket): Promise<void> {
        await this.db.transaction(() => this.runtime.onConnect(socket))
    }

    async onMessage(socket: ActorSocket, message: unknown): Promise<void> {
        await this.db.transaction(() => this.runtime.onMessage(socket, message))
    }

    async onDisconnect(socket: ActorSocket): Promise<void> {
        await this.db.transaction(() => this.runtime.onDisconnect(socket))
    }
}
