import type {
  AgentDefinition,
  AgentPermissions as SdkAgentPermissions,
  RelayYamlConfig,
  WorkflowDefinition,
} from '@relayflows/core';
import type { AgentPermissions } from './permissions.js';

// Accept both the SDK's structured permission shape and cloud's local
// ignored/readonly shape while parsing workflow configs.
export interface CloudAgentDefinition extends Omit<AgentDefinition, 'permissions'> {
  permissions?: AgentPermissions | SdkAgentPermissions;
  scopes?: string[];
}

export interface CloudWorkflowDefinition extends Omit<WorkflowDefinition, 'agents'> {
  agents?: CloudAgentDefinition[];
}

export interface CloudRelayYamlConfig
  extends Omit<RelayYamlConfig, 'agents' | 'workflows'> {
  agents: CloudAgentDefinition[];
  workflows?: CloudWorkflowDefinition[];
}
