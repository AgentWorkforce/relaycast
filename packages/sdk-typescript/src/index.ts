export { SDK_VERSION } from './version.js';
export { RelayCast } from './relay.js';
export type {
  AgentReconnectOptions,
  RelayCastOptions,
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
export { HARNESS_HEADER, sanitizeHarness } from './origin.js';
export {
  relayErrorFromApi,
  normalizeRelayErrorCode,
  relayErrorRetryable,
} from './errors.js';
export type { RelayErrorCode, RelayErrorOptions } from './errors.js';
export {
  appendLegacySuffix,
  isNameConflictError,
} from './identity.js';
export type { RegisterAgentInput, RegisterOrRotateInput, ResolvedIdentity } from './identity.js';
export { WsClient } from './ws.js';
export type { WsClientOptions, EventHandler } from './ws.js';
export type { Subscription } from './subscription.js';
export type * from './types.js';
