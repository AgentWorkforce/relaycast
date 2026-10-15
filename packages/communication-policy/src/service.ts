import { createHash } from "node:crypto";
import { z } from "zod";
import {
  awaitedReply,
  communicationMessage,
  communicationPolicy,
  communicationReceipt,
  conversationGrant,
  decideCommunication,
  type CommunicationPolicy,
  type CommunicationStatus,
} from "./contract.js";

export type StoredPolicy = {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  agentName: string;
  policy: Record<string, unknown>;
  grants: unknown[];
  awaitedReplies: unknown[];
};
export type StoredReceipt = {
  fingerprint: string;
  receipt: Record<string, unknown>;
  dispatching: boolean;
};
export interface CommunicationTransaction<Context> {
  context: Context;
  record: StoredPolicy | null;
  savePolicy(
    patch: Partial<Pick<StoredPolicy, "policy" | "grants" | "awaitedReplies">>,
  ): Promise<void>;
  readReceipt(deliveryKey: string): Promise<StoredReceipt | null>;
  saveReceipt(deliveryKey: string, receipt: StoredReceipt): Promise<void>;
}
/** Storage must atomically commit/rollback each callback and serialize ALL recipient
 * mutations and final injection across every process. A process-local mutex alone
 * is insufficient for shared stores. Dispatch intent commits before external I/O;
 * a failed final commit leaves the durable intent held, preventing blind reinjection.
 */
export interface CommunicationStore<Context> {
  insert(record: StoredPolicy): Promise<boolean>;
  read(id: string): Promise<StoredPolicy | null>;
  binding(workspaceId: string, agentName: string): Promise<StoredPolicy | null>;
  withRecipient<T>(
    id: string,
    fn: (tx: CommunicationTransaction<Context>) => Promise<T>,
  ): Promise<T>;
}

type Identity = CommunicationPolicy["recipient"];
type Message = z.infer<typeof communicationMessage>;
type Receipt = z.infer<typeof communicationReceipt>;
type Grant = z.infer<typeof conversationGrant>;
/** Construct only from verified request auth, never a tool argument. */
export type CommunicationActor = {
  userId: string;
  workspaceId: string;
  organizationId: string;
  kind: "human" | "agent";
  capabilities: readonly ("communication:manage" | "communication:approve")[];
};
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const recipientKey = (identity: Identity) =>
  digest([identity.organizationId, identity.workspaceId, identity.agentId]);
const equalIdentity = (a: Identity, b: Identity) =>
  recipientKey(a) === recipientKey(b);

export function createCommunicationService<Context>(deps: {
  store: CommunicationStore<Context>;
  now(): Date;
  /** Server-owned capability registry must attest ALL ingress/read paths, not a client-supplied flag. */
  verifyTransportCoverage(recipient: Identity): Promise<boolean>;
  verifyOwnership(
    actor: CommunicationActor,
    recipient: Identity,
    agentName: string,
  ): Promise<boolean>;
}) {
  const { store } = deps;
  function authorize(
    actor: CommunicationActor,
    policy: CommunicationPolicy,
    ownerUserId: string,
    permission: "communication:manage" | "communication:approve",
  ) {
    if (
      actor.workspaceId !== policy.recipient.workspaceId ||
      actor.organizationId !== policy.recipient.organizationId ||
      actor.userId !== ownerUserId ||
      (actor.kind !== "human" && !actor.capabilities.includes(permission))
    )
      throw new Error("communication_forbidden");
  }
  async function locked<T>(
    identity: Identity,
    fn: (
      tx: CommunicationTransaction<Context>,
      row: StoredPolicy,
      policy: CommunicationPolicy,
    ) => Promise<T>,
  ) {
    return store.withRecipient(recipientKey(identity), async (tx) => {
      const row = tx.record;
      if (!row) throw new Error("communication_not_enrolled");
      const policy = communicationPolicy.parse(row.policy);
      if (!equalIdentity(policy.recipient, identity))
        throw new Error("communication_wrong_recipient");
      return fn(tx, row, policy);
    });
  }
  function decision(
    row: StoredPolicy,
    policy: CommunicationPolicy,
    message: Message,
    connection: CommunicationStatus["connection"],
    queueSupported: boolean,
  ) {
    return decideCommunication({
      status: {
        schemaVersion: 1,
        policy,
        connection,
        queueSupported,
        revision: policy.revision,
        observedAt: deps.now().toISOString(),
      },
      message,
      grants: z.array(conversationGrant).parse(row.grants),
      awaitedReplies: z.array(awaitedReply).parse(row.awaitedReplies),
      now: deps.now().toISOString(),
    });
  }
  const stateFor = (
    d: ReturnType<typeof decideCommunication>,
  ): Receipt["state"] =>
    d.reason === "grant_expired"
      ? "expired"
      : (
          {
            deliver: "queued",
            request_approval: "pending_approval",
            hold: "held",
            queue: "queued",
            reject: "rejected",
          } as const
        )[d.action];
  function receipt(
    message: Message,
    policyRevision: number,
    state: Receipt["state"],
  ): Receipt {
    return {
      schemaVersion: 1,
      messageId: message.id,
      state,
      policyRevision,
      observedAt: deps.now().toISOString(),
    };
  }
  return {
    async enroll(
      actor: CommunicationActor,
      agentName: string,
      policyInput: CommunicationPolicy,
    ) {
      const policy = communicationPolicy.parse(policyInput);
      authorize(actor, policy, actor.userId, "communication:manage");
      if (
        policy.revision !== 0 ||
        !agentName ||
        !(await deps.verifyOwnership(actor, policy.recipient, agentName)) ||
        !(await deps.verifyTransportCoverage(policy.recipient))
      )
        throw new Error("communication_transport_not_ready");
      const row = await store.insert({
        id: recipientKey(policy.recipient),
        workspaceId: actor.workspaceId,
        ownerUserId: actor.userId,
        agentName,
        policy,
        grants: [],
        awaitedReplies: [],
      });
      if (!row) throw new Error("communication_already_enrolled");
      return policy;
    },
    async updatePolicy(actor: CommunicationActor, input: CommunicationPolicy) {
      const next = communicationPolicy.parse(input);
      return locked(next.recipient, async (tx, row, previous) => {
        authorize(actor, previous, row.ownerUserId, "communication:manage");
        if (next.revision !== previous.revision + 1)
          throw new Error("communication_revision_conflict");
        await tx.savePolicy({ policy: next });
        return next;
      });
    },
    async setGrant(actor: CommunicationActor, input: Grant) {
      const grant = conversationGrant.parse(input);
      return locked(grant.recipient, async (tx, row, policy) => {
        authorize(actor, policy, row.ownerUserId, "communication:approve");
        if (
          grant.sender.workspaceId !== grant.recipient.workspaceId ||
          grant.sender.organizationId !== grant.recipient.organizationId
        )
          throw new Error("communication_wrong_scope");
        const grants = z.array(conversationGrant).parse(row.grants);
        const index = grants.findIndex(
          (g) =>
            equalIdentity(g.sender, grant.sender) &&
            g.conversationId === grant.conversationId,
        );
        const previous = grants[index];
        if (
          !previous ||
          previous.id !== grant.id ||
          grant.revision !== previous.revision + 1
        )
          throw new Error("communication_revision_conflict");
        if (
          grant.state === "approved" &&
          Date.parse(grant.expiresAt) <= deps.now().getTime()
        )
          throw new Error("communication_expired_grant");
        grants[index] = grant;
        await tx.savePolicy({ grants });
        return grant;
      });
    },
    async setAwaitedReplies(
      actor: CommunicationActor,
      identity: Identity,
      expectedRevision: number,
      input: z.infer<typeof awaitedReply>[],
    ) {
      const awaitedReplies = z.array(awaitedReply).max(100).parse(input);
      return locked(identity, async (tx, row, policy) => {
        authorize(actor, policy, row.ownerUserId, "communication:manage");
        if (expectedRevision !== policy.revision)
          throw new Error("communication_revision_conflict");
        if (
          awaitedReplies.some(
            (r) =>
              r.sender.workspaceId !== identity.workspaceId ||
              r.sender.organizationId !== identity.organizationId,
          )
        )
          throw new Error("communication_wrong_scope");
        await tx.savePolicy({
          awaitedReplies,
          policy: { ...policy, revision: policy.revision + 1 },
        });
      });
    },
    async read(identity: Identity) {
      const row = await store.read(recipientKey(identity));
      if (!row) return null;
      return {
        policy: communicationPolicy.parse(row.policy),
        grants: z.array(conversationGrant).parse(row.grants),
      };
    },
    async binding(workspaceId: string, agentName: string) {
      const row = await store.binding(workspaceId, agentName);
      return row ? communicationPolicy.parse(row.policy) : null;
    },
    /** Read-time admission. Caller has already authenticated message sender/recipient and scope. Never returns message text on denial. */
    async inspect(messageInput: Message) {
      const message = communicationMessage.parse(messageInput);
      return locked(message.recipient, async (_tx, row, policy) =>
        decision(row, policy, message, "online", true),
      );
    },
    /** No body is persisted in Status. A knock exposes only sender/conversation identity until approval. */
    async deliver(input: {
      message: Message;
      deliveryKey: string;
      contentHash: string;
      connection: CommunicationStatus["connection"];
      queueSupported: boolean;
      send(context: Context): Promise<boolean>;
    }): Promise<Receipt> {
      const message = communicationMessage.parse(input.message);
      if (!input.deliveryKey || !/^[a-f0-9]{64}$/.test(input.contentHash))
        throw new Error("invalid_delivery_key");
      const id = recipientKey(message.recipient);
      const fingerprint = digest([message, input.contentHash]);
      // Commit a dispatch intent before touching a transport. An ambiguous result is held, never re-injected automatically.
      const prepared = await locked(
        message.recipient,
        async (tx, row, policy) => {
          const existing = await tx.readReceipt(input.deliveryKey);
          if (existing && existing.fingerprint !== fingerprint)
            throw new Error("communication_message_conflict");
          if (existing) {
            const prior = communicationReceipt.parse(existing.receipt);
            if (
              existing.dispatching ||
              ["delivered", "rejected", "expired"].includes(prior.state)
            )
              return { done: prior };
          }
          const d = decision(
            row,
            policy,
            message,
            input.connection,
            input.queueSupported,
          );
          if (d.action === "request_approval") {
            const grants = z.array(conversationGrant).parse(row.grants);
            if (
              !grants.some(
                (g) =>
                  equalIdentity(g.sender, message.sender) &&
                  g.conversationId === message.conversationId,
              )
            ) {
              if (grants.length >= 1000)
                throw new Error("communication_knock_limit");
              grants.push({
                schemaVersion: 1,
                id: digest([
                  id,
                  message.sender.agentId,
                  message.conversationId,
                ]),
                recipient: message.recipient,
                sender: message.sender,
                conversationId: message.conversationId,
                state: "pending",
                revision: 0,
                expiresAt: new Date(
                  deps.now().getTime() + 86_400_000,
                ).toISOString(),
              });
              await tx.savePolicy({ grants });
            }
          }
          const next = receipt(
            message,
            policy.revision,
            d.action === "deliver" ? "held" : stateFor(d),
          );
          await tx.saveReceipt(input.deliveryKey, {
            fingerprint,
            receipt: next,
            dispatching: d.action === "deliver",
          });
          return d.action === "deliver" ? { done: null } : { done: next };
        },
      );
      if (prepared.done) return prepared.done;
      return locked(message.recipient, async (tx, row, policy) => {
        // Lock orders revocation/policy changes with the final injection attempt.
        const d = decision(
          row,
          policy,
          message,
          input.connection,
          input.queueSupported,
        );
        let state = stateFor(d);
        let uncertain = false;
        if (d.action === "deliver") {
          try {
            state = (await input.send(tx.context)) ? "delivered" : "queued";
          } catch {
            state = "held";
            uncertain = true;
          }
        }
        const next = receipt(message, policy.revision, state);
        await tx.saveReceipt(input.deliveryKey, {
          fingerprint,
          receipt: next,
          dispatching: uncertain,
        });
        return next;
      });
    },
  };
}
export type CommunicationService<Context = unknown> = ReturnType<
  typeof createCommunicationService<Context>
>;
