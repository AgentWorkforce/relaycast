export type FleetJson =
  | string
  | number
  | boolean
  | null
  | FleetJson[]
  | { [key: string]: FleetJson };

export type FleetCapability = {
  name: string;
  kind?: string;
  metadata?: Record<string, FleetJson>;
};

export type FleetBrokerMessage =
  | {
      v: 1;
      id?: string;
      type: 'node.register';
      name: string;
      node_id: string;
      capabilities: FleetCapability[];
      max_agents: number;
      tags: string[];
      version: string;
      resume_cursor?: string | null;
    }
  | {
      v: 1;
      id?: string;
      type: 'node.heartbeat';
      load: number;
      active_agents: number;
      handlers_live: boolean;
    }
  | { v: 1; id?: string; type: 'node.deregister' }
  | {
      v: 1;
      id?: string;
      type: 'agent.register';
      name: string;
      invocation_id?: string;
      session_ref?: string;
      resumable?: boolean;
    }
  | {
      v: 1;
      id?: string;
      type: 'agent.deregister';
      agent_id: string;
      name?: string;
    }
  | {
      v: 1;
      id?: string;
      type: 'inventory.sync';
      agents: Array<{
        agent_id: string;
        name: string;
        invocation_id?: string;
        session_ref?: string;
      }>;
    }
  | {
      v: 1;
      id?: string;
      type: 'delivery.ack';
      agent: string;
      up_to_seq: number;
    }
  | {
      v: 1;
      id?: string;
      type: 'action.result';
      invocation_id: string;
      output?: FleetJson;
      error?: string;
    };

export type FleetRelaycastMessage =
  | {
      v: 1;
      type: 'action.invoke';
      invocation_id: string;
      action: string;
      input: FleetJson;
    }
  | {
      v: 1;
      type: 'deliver';
      agent: string;
      msg_id: string;
      seq: number;
      mode: 'wait' | 'steer';
      payload: FleetJson;
    }
  | { v: 1; type: 'ping' }
  | { v: 1; id: string; type: 'reply'; ok: true; data: FleetJson }
  | { v: 1; id: string; type: 'error'; ok: false; code: string; message: string };

export function toFleetJson(value: unknown): FleetJson {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toFleetJson(entry));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, FleetJson> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toFleetJson(entry);
    }
    return out;
  }
  return null;
}

export function normalizeCapabilities(value: unknown): FleetCapability[] {
  if (!Array.isArray(value)) return [];
  const capabilities: FleetCapability[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim()) {
      capabilities.push({ name: entry.trim() });
    } else if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
      const capability = entry as FleetCapability;
      capabilities.push({
        name: capability.name,
        ...(typeof capability.kind === 'string' ? { kind: capability.kind } : {}),
        ...(capability.metadata && typeof capability.metadata === 'object' ? { metadata: capability.metadata } : {}),
      });
    }
  }
  return capabilities;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`Invalid fleet control frame: ${field} must be a string`);
  }
}

function requireOptionalString(value: unknown, field: string): asserts value is string | undefined {
  if (value !== undefined && typeof value !== 'string') {
    throw new Error(`Invalid fleet control frame: ${field} must be a string`);
  }
}

function requireNumber(value: unknown, field: string, integer = false): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`Invalid fleet control frame: ${field} must be a non-negative ${integer ? 'integer' : 'number'}`);
  }
}

function requireStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Invalid fleet control frame: ${field} must be a string array`);
  }
}

function requireCapabilities(value: unknown): asserts value is FleetCapability[] {
  if (!Array.isArray(value)) {
    throw new Error('Invalid fleet control frame: capabilities must be an array');
  }
  for (const capability of value) {
    if (!isObject(capability)) {
      throw new Error('Invalid fleet control frame: capabilities must contain objects');
    }
    requireString(capability.name, 'capabilities[].name');
    requireOptionalString(capability.kind, 'capabilities[].kind');
    if (capability.metadata !== undefined && !isObject(capability.metadata)) {
      throw new Error('Invalid fleet control frame: capabilities[].metadata must be an object');
    }
  }
}

function validateFleetBrokerMessage(parsed: Partial<FleetBrokerMessage>): FleetBrokerMessage {
  if (!isObject(parsed) || parsed.v !== 1 || typeof parsed.type !== 'string') {
    throw new Error('Invalid fleet control frame');
  }
  requireOptionalString(parsed.id, 'id');

  switch (parsed.type) {
    case 'node.register':
      requireString(parsed.name, 'name');
      requireString(parsed.node_id, 'node_id');
      requireCapabilities(parsed.capabilities);
      requireNumber(parsed.max_agents, 'max_agents', true);
      requireStringArray(parsed.tags, 'tags');
      requireString(parsed.version, 'version');
      if (parsed.resume_cursor !== undefined && parsed.resume_cursor !== null && typeof parsed.resume_cursor !== 'string') {
        throw new Error('Invalid fleet control frame: resume_cursor must be a string or null');
      }
      return parsed as FleetBrokerMessage;
    case 'node.heartbeat':
      requireNumber(parsed.load, 'load');
      requireNumber(parsed.active_agents, 'active_agents', true);
      if (typeof parsed.handlers_live !== 'boolean') {
        throw new Error('Invalid fleet control frame: handlers_live must be a boolean');
      }
      return parsed as FleetBrokerMessage;
    case 'node.deregister':
      return parsed as FleetBrokerMessage;
    case 'agent.register':
      requireString(parsed.name, 'name');
      requireOptionalString(parsed.invocation_id, 'invocation_id');
      requireOptionalString(parsed.session_ref, 'session_ref');
      if (parsed.resumable !== undefined && typeof parsed.resumable !== 'boolean') {
        throw new Error('Invalid fleet control frame: resumable must be a boolean');
      }
      return parsed as FleetBrokerMessage;
    case 'agent.deregister':
      requireString(parsed.agent_id, 'agent_id');
      requireOptionalString(parsed.name, 'name');
      return parsed as FleetBrokerMessage;
    case 'inventory.sync':
      if (!Array.isArray(parsed.agents)) {
        throw new Error('Invalid fleet control frame: agents must be an array');
      }
      for (const agent of parsed.agents) {
        if (!isObject(agent)) {
          throw new Error('Invalid fleet control frame: agents must contain objects');
        }
        requireString(agent.agent_id, 'agents[].agent_id');
        requireString(agent.name, 'agents[].name');
        requireOptionalString(agent.invocation_id, 'agents[].invocation_id');
        requireOptionalString(agent.session_ref, 'agents[].session_ref');
      }
      return parsed as FleetBrokerMessage;
    case 'delivery.ack':
      requireString(parsed.agent, 'agent');
      requireNumber(parsed.up_to_seq, 'up_to_seq', true);
      return parsed as FleetBrokerMessage;
    case 'action.result': {
      requireString(parsed.invocation_id, 'invocation_id');
      const hasOutput = Object.prototype.hasOwnProperty.call(parsed, 'output') && parsed.output !== undefined;
      const hasError = Object.prototype.hasOwnProperty.call(parsed, 'error') && parsed.error !== undefined;
      if (hasOutput === hasError) {
        throw new Error('Invalid fleet control frame: action.result must contain exactly one of output or error');
      }
      if (hasError) requireString(parsed.error, 'error');
      return parsed as FleetBrokerMessage;
    }
    default:
      throw new Error(`Invalid fleet control frame: unknown type ${parsed.type}`);
  }
}

export function parseFleetBrokerMessage(raw: string): FleetBrokerMessage {
  const parsed = JSON.parse(raw) as Partial<FleetBrokerMessage>;
  return validateFleetBrokerMessage(parsed);
}

export function replyFrame(id: string | undefined, data: FleetJson): FleetRelaycastMessage {
  return {
    v: 1,
    id: id ?? `reply_${Date.now()}`,
    type: 'reply',
    ok: true,
    data,
  };
}

export function errorFrame(id: string | undefined, code: string, message: string): FleetRelaycastMessage {
  return {
    v: 1,
    id: id ?? `error_${Date.now()}`,
    type: 'error',
    ok: false,
    code,
    message,
  };
}
