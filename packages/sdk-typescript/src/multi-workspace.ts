import { z } from 'zod';
import { AgentClient, type AgentClientOptions } from './agent.js';
import { HttpClient } from './client.js';
import { RelayError } from './errors.js';
import type {
  MessageWithMeta,
  MultiWorkspaceStatus,
  WorkspaceMembershipConfig,
  WorkspaceRef,
  WorkspaceScopedEvent,
  WorkspaceSendTarget,
  WsClientEvent,
} from './types.js';

const membershipConfigSchema = z.object({
  workspaceId: z.string().trim().min(1),
  workspaceAlias: z.string().trim().min(1).optional(),
  agentToken: z.string().trim().min(1),
  agentId: z.string().trim().min(1).optional(),
  agentName: z.string().trim().min(1).optional(),
  baseUrl: z.string().trim().min(1).optional(),
  channels: z.array(z.string().trim().min(1)).optional().default([]),
}).transform((value) => ({
  ...value,
  channels: [...new Set(value.channels)],
}));

interface NormalizedWorkspaceMembershipConfig extends WorkspaceMembershipConfig {
  channels: string[];
}

interface WorkspaceRuntime {
  config: NormalizedWorkspaceMembershipConfig;
  agent: AgentClient;
  channels: Set<string>;
  connected: boolean;
  detachHandlers: (() => void) | null;
}

export interface MultiWorkspaceSessionManagerOptions {
  memberships: WorkspaceMembershipConfig[];
  defaultWorkspaceId?: string;
  agentClientOptions?: AgentClientOptions;
}

export class MultiWorkspaceSessionManager {
  public readonly defaultWorkspaceId?: string;

  private readonly runtimes = new Map<string, WorkspaceRuntime>();
  private readonly aliasToWorkspaceId = new Map<string, string>();
  private readonly workspaceOrder: string[] = [];
  private readonly anyHandlers = new Set<(event: WorkspaceScopedEvent<WsClientEvent>) => void>();
  private readonly workspaceHandlers = new Map<string, Set<(event: WorkspaceScopedEvent<WsClientEvent>) => void>>();

  constructor(options: MultiWorkspaceSessionManagerOptions) {
    const normalizedMemberships = options.memberships.map((membership) => membershipConfigSchema.parse(membership));

    if (normalizedMemberships.length === 0) {
      throw new Error('At least one workspace membership is required.');
    }

    this.defaultWorkspaceId = options.defaultWorkspaceId?.trim() || undefined;

    for (const membership of normalizedMemberships) {
      if (this.runtimes.has(membership.workspaceId)) {
        throw new Error(`Duplicate workspaceId "${membership.workspaceId}" is not allowed.`);
      }
      if (membership.workspaceAlias) {
        if (this.aliasToWorkspaceId.has(membership.workspaceAlias)) {
          throw new Error(`Duplicate workspaceAlias "${membership.workspaceAlias}" is not allowed.`);
        }
        this.aliasToWorkspaceId.set(membership.workspaceAlias, membership.workspaceId);
      }

      const agent = new AgentClient(
        new HttpClient({
          apiKey: membership.agentToken,
          ...(membership.baseUrl ? { baseUrl: membership.baseUrl } : {}),
        }),
        options.agentClientOptions,
      );

      this.workspaceOrder.push(membership.workspaceId);
      this.runtimes.set(membership.workspaceId, {
        config: membership,
        agent,
        channels: new Set(membership.channels),
        connected: false,
        detachHandlers: null,
      });
    }

    if (this.defaultWorkspaceId && !this.runtimes.has(this.defaultWorkspaceId)) {
      throw new Error(`defaultWorkspaceId "${this.defaultWorkspaceId}" is not configured.`);
    }
  }

  connectAll(): void {
    for (const workspaceId of this.workspaceOrder) {
      const runtime = this.runtimes.get(workspaceId)!;
      this.attachRuntimeHandlers(runtime);
      runtime.agent.connect();
    }
  }

  async disconnectAll(): Promise<void> {
    await Promise.all(this.workspaceOrder.map(async (workspaceId) => {
      const runtime = this.runtimes.get(workspaceId)!;
      runtime.connected = false;
      await runtime.agent.disconnect();
    }));
  }

  subscribe(workspace: WorkspaceRef, channels: string[]): void {
    const runtime = this.resolveRuntime(workspace);
    const nextChannels = this.normalizeChannels(channels);
    if (nextChannels.length === 0) return;

    for (const channel of nextChannels) {
      runtime.channels.add(channel);
    }

    if (runtime.connected) {
      runtime.agent.subscribe(nextChannels);
    }
  }

  unsubscribe(workspace: WorkspaceRef, channels: string[]): void {
    const runtime = this.resolveRuntime(workspace);
    const nextChannels = this.normalizeChannels(channels).filter((channel) => runtime.channels.has(channel));
    if (nextChannels.length === 0) return;

    for (const channel of nextChannels) {
      runtime.channels.delete(channel);
    }

    if (runtime.connected) {
      runtime.agent.unsubscribe(nextChannels);
    }
  }

  onAnyEvent(handler: (event: WorkspaceScopedEvent<WsClientEvent>) => void): () => void {
    this.anyHandlers.add(handler);
    return () => {
      this.anyHandlers.delete(handler);
    };
  }

  onWorkspaceEvent(
    workspace: string | WorkspaceRef,
    handler: (event: WorkspaceScopedEvent<WsClientEvent>) => void,
  ): () => void {
    const runtime = typeof workspace === 'string'
      ? this.resolveRuntime({ workspaceId: workspace })
      : this.resolveRuntime(workspace);
    const handlers = this.workspaceHandlers.get(runtime.config.workspaceId) ?? new Set();
    handlers.add(handler);
    this.workspaceHandlers.set(runtime.config.workspaceId, handlers);

    return () => {
      const current = this.workspaceHandlers.get(runtime.config.workspaceId);
      current?.delete(handler);
      if (current && current.size === 0) {
        this.workspaceHandlers.delete(runtime.config.workspaceId);
      }
    };
  }

  agentFor(workspace?: WorkspaceRef): AgentClient {
    return this.resolveRuntime(workspace).agent;
  }

  async send(target: WorkspaceSendTarget): Promise<MessageWithMeta> {
    const runtime = this.resolveRuntime(target);
    return await runtime.agent.send(target.to, target.message, {
      ...(target.attachments ? { attachments: target.attachments } : {}),
      ...(target.blocks ? { blocks: target.blocks } : {}),
      ...(target.idempotencyKey ? { idempotencyKey: target.idempotencyKey } : {}),
    });
  }

  status(): MultiWorkspaceStatus {
    return {
      ...(this.defaultWorkspaceId ? { defaultWorkspaceId: this.defaultWorkspaceId } : {}),
      memberships: this.workspaceOrder.map((workspaceId) => {
        const runtime = this.runtimes.get(workspaceId)!;
        return {
          workspaceId: runtime.config.workspaceId,
          ...(runtime.config.workspaceAlias ? { workspaceAlias: runtime.config.workspaceAlias } : {}),
          ...(runtime.config.agentId ? { agentId: runtime.config.agentId } : {}),
          ...(runtime.config.agentName ? { agentName: runtime.config.agentName } : {}),
          connected: runtime.connected,
          channels: [...runtime.channels],
        };
      }),
    };
  }

  private attachRuntimeHandlers(runtime: WorkspaceRuntime): void {
    if (runtime.detachHandlers) return;

    runtime.detachHandlers = runtime.agent.attachWsHandlers({
      connected: () => {
        runtime.connected = true;
        const channels = [...runtime.channels];
        if (channels.length > 0) {
          runtime.agent.subscribe(channels);
        }
      },
      disconnected: () => {
        runtime.connected = false;
      },
      reconnecting: () => {
        runtime.connected = false;
      },
      permanentlyDisconnected: () => {
        runtime.connected = false;
      },
      any: (event) => {
        this.emitScopedEvent(runtime, event);
      },
    });
  }

  private emitScopedEvent(runtime: WorkspaceRuntime, event: WsClientEvent): void {
    const scopedEvent: WorkspaceScopedEvent<WsClientEvent> = {
      workspaceId: runtime.config.workspaceId,
      ...(runtime.config.workspaceAlias ? { workspaceAlias: runtime.config.workspaceAlias } : {}),
      ...(runtime.config.agentId ? { agentId: runtime.config.agentId } : {}),
      ...(runtime.config.agentName ? { agentName: runtime.config.agentName } : {}),
      event,
    };

    for (const handler of this.anyHandlers) {
      handler(scopedEvent);
    }

    const handlers = this.workspaceHandlers.get(runtime.config.workspaceId);
    if (!handlers) return;
    for (const handler of handlers) {
      handler(scopedEvent);
    }
  }

  private resolveRuntime(workspace?: WorkspaceRef): WorkspaceRuntime {
    const workspaceId = workspace?.workspaceId?.trim() || undefined;
    const workspaceAlias = workspace?.workspaceAlias?.trim() || undefined;

    if (workspaceId) {
      const runtime = this.runtimes.get(workspaceId);
      if (!runtime) {
        throw new RelayError('not_found', `Workspace membership not found for workspaceId "${workspaceId}".`);
      }
      return runtime;
    }

    if (workspaceAlias) {
      const resolvedWorkspaceId = this.aliasToWorkspaceId.get(workspaceAlias);
      if (!resolvedWorkspaceId) {
        throw new RelayError('not_found', `Workspace membership not found for workspaceAlias "${workspaceAlias}".`);
      }
      return this.runtimes.get(resolvedWorkspaceId)!;
    }

    if (this.workspaceOrder.length === 1) {
      return this.runtimes.get(this.workspaceOrder[0]!)!;
    }

    if (this.defaultWorkspaceId) {
      return this.runtimes.get(this.defaultWorkspaceId)!;
    }

    throw new RelayError(
      'transport_error',
      'Ambiguous workspace selection. Provide workspaceId or workspaceAlias.',
    );
  }

  private normalizeChannels(channels: string[]): string[] {
    return [...new Set(channels
      .map((channel) => channel.trim())
      .filter((channel) => channel.length > 0))];
  }
}
