export {
  handleNodeControlMessage,
  // Node-offline lifecycle for out-of-process socket owners (e.g. the
  // relaycast-cloud NodeDO): when a provider's control socket drops, drive
  // `handleProviderDisconnect` — it flips only that provider (and its agents)
  // offline while the node stays online, or, when it was the node's last
  // connection, marks the whole node offline. `markNodeOffline` is the node-wide
  // marker for the other lifecycle triggers a socket owner controls (a liveness
  // alarm lapse, an operator disconnect). Both encapsulate the provider-row,
  // agent, aggregate, and invocation-reschedule effects so a host never
  // hand-rolls them.
  handleProviderDisconnect,
  markNodeOffline,
  type HandleNodeControlMessageArgs,
  type NodeSocketLike,
} from './engine/node.js';
export type { InvocationCompletionDeps } from './engine/invocationCompletion.js';
// Provider-attach arbitration policy (spec §3.1), exported so an out-of-process
// socket owner (the relaycast-cloud NodeDO) mirrors the decision and the liveness
// window from one source of truth instead of hand-copying the constant + logic.
export {
  providerAttachDecision,
  PROVIDER_ATTACH_LIVENESS_MS,
  type ProviderAttachDecision,
  type ProviderAttachDecisionInput,
  type ProviderAttachConflictCode,
} from './engine/placement.js';
