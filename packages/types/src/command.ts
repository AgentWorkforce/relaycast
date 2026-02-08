export interface AgentCommand {
  id: string;
  workspace_id: string;
  command: string;
  description: string;
  handler_agent_id: string;
  handler_agent_name: string;
  parameters: CommandParameter[];
  created_at: string;
  is_active: boolean;
}

export interface CommandParameter {
  name: string;
  description?: string;
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
}

export interface CreateCommandRequest {
  command: string;
  description: string;
  handler_agent: string;
  parameters?: CommandParameter[];
}

export interface CreateCommandResponse {
  id: string;
  command: string;
  description: string;
  handler_agent: string;
  parameters: CommandParameter[];
  created_at: string;
}

export interface InvokeCommandRequest {
  channel: string;
  args?: string;
  parameters?: Record<string, unknown>;
}

export interface CommandInvocation {
  id: string;
  command: string;
  channel: string;
  invoked_by: string;
  args: string | null;
  parameters: Record<string, unknown> | null;
  response_message_id: string | null;
  created_at: string;
}
