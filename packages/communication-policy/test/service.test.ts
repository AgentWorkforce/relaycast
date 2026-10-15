import { beforeEach, expect, it, vi } from "vitest";
import {
  createCommunicationService,
  type CommunicationStore,
  type StoredPolicy,
  type StoredReceipt,
} from "../src/service.js";
import type { CommunicationPolicy } from "../src/contract.js";
const recipient = {
  organizationId: "org",
  workspaceId: "rw_prod",
  agentId: "receiver",
};
const sender = { ...recipient, agentId: "sender" };
const actor = {
  userId: "user",
  workspaceId: recipient.workspaceId,
  organizationId: recipient.organizationId,
  kind: "human" as const,
  capabilities: [],
};
const policy: CommunicationPolicy = {
  schemaVersion: 1,
  recipient,
  revision: 0,
  admission: "open",
  interruption: "available",
  allowedAgentIds: [],
};
const now = new Date("2026-10-14T00:00:00Z");
const message = {
  id: "message",
  recipient,
  sender,
  conversationId: "conversation",
  inReplyTo: null,
};
let rows: Map<string, StoredPolicy>,
  receipts: Map<string, StoredReceipt>,
  tail: Promise<unknown>;
let locks: number,
  beforeLock: ((n: number) => Promise<void>) | undefined,
  failCommit: boolean;
let service: ReturnType<typeof createCommunicationService<void>>;
const send = vi.fn(async () => true);
const delivery = () => ({
  message,
  deliveryKey: "delivery",
  contentHash: "a".repeat(64),
  connection: "online" as const,
  queueSupported: true,
  send,
});
beforeEach(() => {
  rows = new Map();
  receipts = new Map();
  tail = Promise.resolve();
  locks = 0;
  beforeLock = undefined;
  failCommit = false;
  send.mockReset();
  send.mockResolvedValue(true);
  const store: CommunicationStore<void> = {
    async insert(row) {
      if (rows.has(row.id)) return false;
      rows.set(row.id, structuredClone(row));
      return true;
    },
    async read(id) {
      return structuredClone(rows.get(id) ?? null);
    },
    async binding(workspaceId, agentName) {
      return structuredClone(
        [...rows.values()].find(
          (r) => r.workspaceId === workspaceId && r.agentName === agentName,
        ) ?? null,
      );
    },
    async withRecipient(id, fn) {
      await beforeLock?.(++locks);
      const operation = tail.then(async () => {
        const nextRows = structuredClone(rows),
          nextReceipts = structuredClone(receipts);
        const key = (deliveryKey: string) => JSON.stringify([id, deliveryKey]);
        const result = await fn({
          context: undefined,
          record: nextRows.get(id) ?? null,
          async savePolicy(patch) {
            Object.assign(nextRows.get(id)!, patch);
          },
          async readReceipt(k) {
            return nextReceipts.get(key(k)) ?? null;
          },
          async saveReceipt(k, value) {
            nextReceipts.set(key(k), value);
          },
        });
        if (failCommit) {
          failCommit = false;
          throw Error("commit failed");
        }
        rows = nextRows;
        receipts = nextReceipts;
        return result;
      });
      tail = operation.catch(() => undefined);
      return operation;
    },
  };
  service = createCommunicationService({
    store,
    now: () => now,
    verifyOwnership: async () => true,
    verifyTransportCoverage: async () => true,
  });
});
it("serializes concurrent delivery and exact retries without reinjection", async () => {
  await service.enroll(actor, "receiver", policy);
  const result = await Promise.all([
    service.deliver(delivery()),
    service.deliver(delivery()),
  ]);
  expect(result.some((r) => r.state === "delivered")).toBe(true);
  expect(send).toHaveBeenCalledTimes(1);
  expect((await service.deliver(delivery())).state).toBe("delivered");
  expect(send).toHaveBeenCalledTimes(1);
  await expect(
    service.deliver({ ...delivery(), contentHash: "b".repeat(64) }),
  ).rejects.toThrow("message_conflict");
});
it("owns knock creation, approval, conversation scope, and revocation", async () => {
  await service.enroll(actor, "receiver", { ...policy, admission: "knock" });
  expect((await service.deliver(delivery())).state).toBe("pending_approval");
  await service.deliver(delivery());
  const [grant] = (await service.read(recipient))!.grants;
  expect((await service.read(recipient))!.grants).toHaveLength(1);
  expect(send).not.toHaveBeenCalled();
  await service.setGrant(actor, { ...grant!, revision: 1, state: "approved" });
  expect((await service.inspect(message)).action).toBe("deliver");
  expect(
    (await service.inspect({ ...message, conversationId: "other" })).action,
  ).toBe("request_approval");
  await service.setGrant(actor, { ...grant!, revision: 2, state: "revoked" });
  expect((await service.inspect(message)).reason).toBe("grant_revoked");
});
it("rechecks policy between durable intent and final injection", async () => {
  await service.enroll(actor, "receiver", policy);
  beforeLock = async (n) => {
    if (n === 2)
      await service.updatePolicy(actor, {
        ...policy,
        revision: 1,
        admission: "allow_list",
      });
  };
  expect((await service.deliver(delivery())).state).toBe("rejected");
  expect(send).not.toHaveBeenCalled();
});
it("retains the committed intent if the final receipt commit fails", async () => {
  await service.enroll(actor, "receiver", policy);
  send.mockImplementationOnce(async () => {
    failCommit = true;
    return true;
  });
  await expect(service.deliver(delivery())).rejects.toThrow("commit failed");
  expect((await service.deliver(delivery())).state).toBe("held");
  expect(send).toHaveBeenCalledTimes(1);
});
it("does not dispatch if the intent cannot commit", async () => {
  await service.enroll(actor, "receiver", policy);
  failCommit = true;
  await expect(service.deliver(delivery())).rejects.toThrow("commit failed");
  expect(send).not.toHaveBeenCalled();
});
it("requires owner authority for policy, grants and awaited replies", async () => {
  await service.enroll(actor, "receiver", policy);
  await expect(
    service.updatePolicy(
      { ...actor, userId: "other" },
      { ...policy, revision: 1 },
    ),
  ).rejects.toThrow("forbidden");
  await expect(
    service.setAwaitedReplies({ ...actor, kind: "agent" }, recipient, 0, []),
  ).rejects.toThrow("forbidden");
  await expect(
    service.updatePolicy(actor, { ...policy, revision: 3 }),
  ).rejects.toThrow("revision_conflict");
});
