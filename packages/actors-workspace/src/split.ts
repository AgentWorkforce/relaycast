/**
 * Per-entity actors of the split topology (prototype, `RELAYCAST_ACTORS_TOPOLOGY=split`
 * on the gateway). The `Workspace` actor stays the metadata owner; the hot
 * path (DM send, channel post, delivery to inbox, ack) runs here, so one
 * busy channel or inbox no longer queues every other write of its workspace.
 * See `@relaycast/engine/adapters/actor` `split` for the data model.
 *
 * Calls between these actors only go one way (source -> inbox), so no call
 * waits on an actor that waits on it. The gateway drives the hand-off on the
 * hot path; a source's alarm redrives what the gateway did not confirm.
 */
import { Actor, Ephemeral, type ActorAlarm, type ActorContext, type ActorDatabase, type ActorSocket } from "durable-actors"
import { split } from "@relaycast/engine/adapters/actor"

/** Delay before a failed redrive is tried again. */
const REDRIVE_RETRY_MS = 5_000

/**
 * What a source actor (Channel, Conversation) does, over its database and
 * alarm. durable-actors needs every actor class to extend `Actor` directly,
 * so the two classes below delegate here instead of sharing a base class.
 */
class SourceCore {
    private readonly actorId: string
    private readonly db: ActorDatabase
    private readonly alarm: ActorAlarm
    private readonly source: split.SplitSource

    constructor(actorId: string, db: ActorDatabase, alarm: ActorAlarm) {
        this.actorId = actorId
        this.db = db
        this.alarm = alarm
        this.source = split.createSplitSource(db, { actorId })
    }

    post(input: split.SourcePost): Promise<split.SourcePostResult> {
        return this.db.transaction(async () => {
            const result = this.source.post(input)
            // Only an idle alarm is set, so a steady stream of posts costs no extra alarm writes.
            if (this.alarm.get() === null) this.alarm.set(Date.now() + split.REDRIVE_AFTER_MS + 500)
            return result
        })
    }

    confirm(confirmations: split.Confirmation[]): Promise<void> {
        return this.db.transaction(async () => this.source.confirm(confirmations))
    }

    history(limit: number): ReturnType<split.SplitSource["history"]> {
        return this.source.history(limit)
    }

    /** Redrive outbox entries the gateway did not confirm (a gateway that died mid hand-off). */
    async redrive(): Promise<void> {
        const due = this.source.dueHandoffs()
        const workspaceId = split.parseSplitActorId(this.actorId)?.workspaceId
        const settled = workspaceId
            ? await Promise.allSettled(due.map(handoff => Inbox.get(split.inboxActorId(workspaceId, handoff.agent.id)).accept(handoff)))
            : []
        await this.db.transaction(async () => {
            const confirmed: split.Confirmation[] = []
            settled.forEach((outcome, i) => {
                if (outcome.status === "fulfilled") confirmed.push({ recipient: due[i]!.agent.id, through: outcome.value.through })
            })
            this.source.confirm(confirmed)
            const next = this.source.nextRedriveAt()
            if (next !== null) this.alarm.set(Math.max(next, Date.now() + REDRIVE_RETRY_MS))
        })
    }
}

/** A channel (`<workspace>-ch-<channel id>`): message order, history and the outbox to member inboxes. */
export class Channel extends Actor {
    @Ephemeral private core: SourceCore

    constructor(context: ActorContext) {
        super(context)
        this.core = new SourceCore(this.id, this.db, this.alarm)
    }

    /** One message, committed with its outbox entries in one write; the caller runs the returned hand-offs. */
    async post(input: split.SourcePost): Promise<split.SourcePostResult> {
        return this.core.post(input)
    }

    /** Drop outbox entries the recipients' inboxes accepted. */
    async confirm(confirmations: split.Confirmation[]): Promise<void> {
        return this.core.confirm(confirmations)
    }

    /** Recent history, oldest first (verification). */
    async history(limit = 100): Promise<ReturnType<split.SplitSource["history"]>> {
        return this.core.history(limit)
    }

    async onAlarm(): Promise<void> {
        await this.core.redrive()
    }
}

/** A 1:1 DM conversation (`<workspace>-dm-<pair key>`): message order, history and the outbox to the recipient's inbox. */
export class Conversation extends Actor {
    @Ephemeral private core: SourceCore

    constructor(context: ActorContext) {
        super(context)
        this.core = new SourceCore(this.id, this.db, this.alarm)
    }

    async post(input: split.SourcePost): Promise<split.SourcePostResult> {
        return this.core.post(input)
    }

    async confirm(confirmations: split.Confirmation[]): Promise<void> {
        return this.core.confirm(confirmations)
    }

    async history(limit = 100): Promise<ReturnType<split.SplitSource["history"]>> {
        return this.core.history(limit)
    }

    async onAlarm(): Promise<void> {
        await this.core.redrive()
    }
}

/**
 * An agent's inbox (`<workspace>-in-<agent id>`): pending deliveries, the
 * delivery seq and the ack cursor. The gateway opens one socket here per
 * agent attached to a node socket; accepted deliveries go out as engine
 * `deliver` frames, unacked ones are replayed when a socket connects, and
 * `delivery.ack` frames move the cursor.
 */
export class Inbox extends Actor {
    @Ephemeral private inbox: split.SplitInbox

    constructor(context: ActorContext) {
        super(context)
        this.inbox = split.createSplitInbox(this.db)
    }

    async accept(handoff: split.InboxHandoff): Promise<split.InboxAcceptResult> {
        const { result, frames } = await this.db.transaction(async () => this.inbox.accept(handoff))
        for (const frame of frames) this.broadcast(frame as never)
        return result
    }

    async onConnect(socket: ActorSocket): Promise<void> {
        const metadata = split.InboxSocketMetadataSchema.safeParse(socket.metadata)
        const owner = split.parseSplitActorId(this.id)
        if (!metadata.success || !owner || owner.kind !== "in"
            || metadata.data.workspace_id !== owner.workspaceId || metadata.data.agent_id !== owner.entity) {
            socket.reject(4400, "not a socket for this inbox")
            return
        }
        // The schema may be created here, so the replay reads run in the call's transaction.
        const pending = await this.db.transaction(async () => this.inbox.pending())
        for (const frame of pending) socket.send(frame as never)
    }

    async onMessage(_socket: ActorSocket, message: unknown): Promise<void> {
        const frame = message as { type?: unknown; up_to_seq?: unknown } | null
        if (frame?.type !== "delivery.ack" || typeof frame.up_to_seq !== "number") return
        const upToSeq = frame.up_to_seq
        await this.db.transaction(async () => { this.inbox.ack(upToSeq) })
    }

    async onDisconnect(_socket: ActorSocket): Promise<void> {}
}
