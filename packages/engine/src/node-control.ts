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
