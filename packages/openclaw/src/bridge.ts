import { Relay, AgentClient, WsClient } from '@relaycast/sdk';
import type { Agent } from '@relaycast/types';

export interface ClawIdentity {
  /** Name for this claw instance (used as Relaycast agent name). */
  name: string;
  /** Optional persona description. */
  persona?: string;
}

export interface OpenClawBridgeOptions {
  /** Relaycast workspace API key (rk_live_*). */
  apiKey: string;
  /** Relaycast API base URL. */
  baseUrl?: string;
  /** Identity for this claw instance. */
  claw: ClawIdentity;
  /** Auto-join these channels on connect. */
  channels?: string[];
  /** Enable real-time WebSocket events. */
  realtime?: boolean;
}

/**
 * OpenClawBridge connects an OpenClaw instance to a Relaycast workspace.
 *
 * Each claw registers as a Relaycast agent, gaining access to channels,
 * threads, DMs, reactions, search, and persistent message history — things
 * OpenClaw's built-in sessions_* tools don't provide.
 *
 * Usage:
 * ```ts
 * const bridge = new OpenClawBridge({
 *   apiKey: 'rk_live_xxx',
 *   claw: { name: 'my-claw', persona: 'Home automation assistant' },
 *   channels: ['general', 'alerts'],
 * });
 * await bridge.connect();
 * await bridge.send('#general', 'Online and ready.');
 * ```
 */
export class OpenClawBridge {
  private relay: Relay;
  private agent: AgentClient | null = null;
  private ws: WsClient | null = null;
  private agentToken: string | null = null;
  private options: OpenClawBridgeOptions;

  constructor(options: OpenClawBridgeOptions) {
    this.options = options;
    this.relay = new Relay({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
    });
  }

  /**
   * Register this claw as a Relaycast agent, join channels, and optionally
   * open a WebSocket for real-time events.
   */
  async connect(): Promise<Agent> {
    const result = await this.relay.agents.register({
      name: this.options.claw.name,
      type: 'agent',
      persona: this.options.claw.persona,
    });

    this.agentToken = result.token;
    this.agent = this.relay.as(result.token);

    if (this.options.channels) {
      for (const ch of this.options.channels) {
        const name = ch.startsWith('#') ? ch.slice(1) : ch;
        try {
          await this.agent.channels.join(name);
        } catch {
          // Channel may not exist yet — create and join
          await this.agent.channels.create({ name });
        }
      }
    }

    if (this.options.realtime) {
      this.ws = new WsClient({
        token: result.token,
        baseUrl: this.options.baseUrl,
      });
      this.ws.connect();

      if (this.options.channels) {
        this.ws.subscribe(
          this.options.channels.map((ch) =>
            ch.startsWith('#') ? ch.slice(1) : ch,
          ),
        );
      }
    }

    return result as unknown as Agent;
  }

  /** Get the underlying AgentClient for direct SDK access. */
  getAgent(): AgentClient {
    if (!this.agent) {
      throw new Error(
        'Bridge not connected. Call connect() first.',
      );
    }
    return this.agent;
  }

  /** Get the WebSocket client (only available if realtime: true). */
  getWs(): WsClient | null {
    return this.ws;
  }

  /** Get the agent token for this claw (available after connect). */
  getToken(): string | null {
    return this.agentToken;
  }

  // ── Convenience methods that proxy to AgentClient ──

  async send(channel: string, text: string) {
    return this.getAgent().send(channel, text);
  }

  async dm(agent: string, text: string) {
    return this.getAgent().dm(agent, text);
  }

  async reply(messageId: string, text: string) {
    return this.getAgent().reply(messageId, text);
  }

  async react(messageId: string, emoji: string) {
    return this.getAgent().react(messageId, emoji);
  }

  async search(query: string, opts?: { channel?: string; from?: string }) {
    return this.getAgent().search(query, opts);
  }

  async inbox() {
    return this.getAgent().inbox();
  }

  /** Disconnect WebSocket and clean up. */
  disconnect() {
    if (this.ws) {
      this.ws.disconnect();
      this.ws = null;
    }
    this.agent = null;
    this.agentToken = null;
  }
}
