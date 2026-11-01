import { Actor, Ephemeral, type ActorContext } from "durable-actors"
import {
    createActorRuntime,
    type ActorHttpRequest,
    type ActorHttpResponse,
    type ActorRuntime,
} from "@relaycast/engine/adapters/actor"

function requiredEnv(name: string): string {
    const value = process.env[name]
    if (!value) throw new Error(`${name} is not set`)
    return value
}

/**
 * One relaycast workspace per actor: the actor id is the workspace id, and the
 * engine runs on the actor's SQLite. A gateway calls `create` for
 * `POST /v1/workspaces` and `handle` for everything else, routing by the
 * workspace id inside each `relaycast_` credential.
 *
 * Each call is one transaction that rolls back if it throws; engine write
 * groups nest inside it (`db.transaction`, durable-actors >= 0.14.5).
 */
export class Workspace extends Actor {
    @Ephemeral private runtime: ActorRuntime

    constructor(context: ActorContext) {
        super(context)
        this.runtime = createActorRuntime({
            sql: this.db,
            workspaceId: this.id,
            // Where clients reach the gateway; signed file URLs point at its /_relayfiles.
            baseUrl: requiredEnv("RELAYCAST_PUBLIC_URL"),
            fileSigningSecret: requiredEnv("RELAYCAST_FILE_SIGNING_SECRET"),
            outboundFetch: (input, init) => globalThis.fetch(input, init),
            alarm: this.alarm,
            // The gateway reads request bodies up to this size (MAX_BODY_BYTES in gateway/server.ts).
            config: { maxUploadBytes: 64 * 1024 * 1024 },
            // Engine errors and alerts (e.g. alert: "maintenance_rolled_back") go to the actor's log.
            telemetry: {
                capture() {},
                captureException: (error, context) => console.error("relaycast", JSON.stringify(context ?? {}), error),
            },
        })
    }

    /** `POST /v1/workspaces`, with the tag the gateway's keyring signed for this id. */
    async create(request: ActorHttpRequest, credentialTag: string): Promise<ActorHttpResponse> {
        return this.runtime.create(request, credentialTag)
    }

    async handle(request: ActorHttpRequest): Promise<ActorHttpResponse> {
        return this.runtime.handle(request)
    }

    /** Outbound HTTP (webhooks, http_push, A2A egress) and maintenance run here, never inside a request. */
    async onAlarm(): Promise<void> {
        await this.runtime.maintain()
    }
}
