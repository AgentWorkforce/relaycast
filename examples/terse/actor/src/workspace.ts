import { Actor, Atomic, Ephemeral, type ActorContext } from "terse-sdk/actor"
import {
    createActorRuntime,
    type ActorHttpRequest,
    type ActorHttpResponse,
    type ActorRuntime,
    type ActorWriteGroupFailure,
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
            // Engine errors and alerts (e.g. alert: "maintenance_rolled_back") go to the actor's log.
            telemetry: {
                capture() {},
                captureException: (error, context) => console.error("relaycast", JSON.stringify(context ?? {}), error),
            },
        })
    }

    @Atomic
    async create(request: ActorHttpRequest, replay: ActorWriteGroupFailure[]): Promise<ActorHttpResponse> {
        const { pathname } = new URL(request.url)
        if (request.method !== "POST" || pathname !== "/v1/workspaces") {
            throw new Error("create serves POST /v1/workspaces only")
        }
        return this.runtime.handle(request, replay)
    }

    @Atomic
    async handle(request: ActorHttpRequest, replay: ActorWriteGroupFailure[]): Promise<ActorHttpResponse> {
        return this.runtime.handle(request, replay)
    }

    /** Outbound HTTP (webhooks, http_push, A2A egress) and maintenance run here, never inside a request. */
    @Atomic
    async onAlarm(): Promise<void> {
        await this.runtime.maintain()
    }
}
