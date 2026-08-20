export { SDK_VERSION } from './version.js';
export { RelayCast } from './relay.js';
export type {
  AgentReconnectOptions,
  RelayCastOptions,
  WorkspaceBootstrapOptions,
  WorkspaceLookupOptions,
  EnsureWorkspaceResponse,
} from './relay.js';
export { Relay } from './communicate/relay.js';
export type { Message, MessageCallback, RelayConfig } from './communicate/types.js';
export { RelaycastSetup, WorkspaceHandle } from './setup.js';
export type {
  AgentRecord,
  CreateWorkspaceOptions,
  JoinWorkspaceOptions,
  RegisterAgentOptions,
  RelaycastSetupOptions,
  WorkspaceInfo,
} from './setup-types.js';
export {
  AgentNotRegisteredError,
  MalformedApiResponseError,
  MissingApiKeyError,
  RelaycastApiError,
  RelaycastSetupError,
  WorkspaceNotFoundError,
} from './setup-errors.js';
export type { RelaycastSetupErrorCode } from './setup-errors.js';
export { AgentClient } from './agent.js';
export type { AgentClientOptions } from './agent.js';
export { HttpClient, RelayError } from './client.js';
export type { ClientOptions } from './client.js';
export {
  AGENT_RELAY_DISTINCT_ID_HEADER,
  AGENT_RELAY_DISTINCT_ID_QUERY,
  ORIGIN_ACTOR_HEADER,
  sanitizeAgentRelayDistinctId,
  sanitizeOriginActor,
} from './origin.js';
export {
  relayErrorFromApi,
  normalizeRelayErrorCode,
  relayErrorRetryable,
} from './errors.js';
export type { RelayErrorCode, RelayErrorOptions } from './errors.js';
export type {
  AgentIdentityRecoveryResponse,
  AgentIdentityRevocationResponse,
  EnrollRecoveryCredentialInput,
  RecoverAgentInput,
  RegisterAgentInput,
  RegisterOrRotateInput,
  ResolvedIdentity,
  RevokeAgentTokenInput,
  TakeOverAgentInput,
} from './identity.js';
export { WsClient } from './ws.js';
export type { WsClientOptions, EventHandler } from './ws.js';
export { NodeProviderClient, NodeRegistrationError } from './node-provider.js';
export type {
  NodeProviderOptions,
  NodeCapabilityOptions,
  NodeCapabilityHandler,
  NodeHandlerContext,
  NodeSendMessageInput,
} from './node-provider.js';
export type { Subscription } from './subscription.js';
export type * from './types.js';
