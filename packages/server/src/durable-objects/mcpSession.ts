import type { CloudflareBindings } from '../env.js';

/**
 * McpSessionDO — stateful MCP session actor.
 *
 * Each MCP client session maps to one DO instance keyed by session ID.
 * The DO holds the MCP server + WebStandard transport in memory, providing
 * statefulness across requests (workspace key, agent token, subscriptions).
 *
 * On first request (initialize), a new transport + MCP server are created.
 * Subsequent requests are routed to the same DO via the mcp-session-id header.
 *
 * The DO uses Cloudflare's hibernation-compatible model: state lives in
 * memory while the DO is active. If the DO is evicted, the client must
 * re-initialize (the session ID becomes invalid and the transport returns 404).
 */
export class McpSessionDO implements DurableObject {
  private state: DurableObjectState;
  private env: CloudflareBindings;

  /**
   * Lazily-initialized MCP transport and server.
   * These are kept in memory for the lifetime of the DO instance.
   */
  private transport: import('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js').WebStandardStreamableHTTPServerTransport | null = null;
  private mcpServer: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer | null = null;

  constructor(state: DurableObjectState, env: CloudflareBindings) {
    this.state = state;
    this.env = env;
  }

  /**
   * Initialize the MCP server + transport on first request.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.transport) return;

    const { WebStandardStreamableHTTPServerTransport } =
      await import('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js');
    const { createRelayMcpServer } =
      await import('@relaycast/mcp');

    // Create transport in stateful mode with the DO ID as session ID.
    this.transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => this.state.id.toString(),
    });

    // Create the MCP server with optional pre-configured API key.
    const apiKey = await this.state.storage.get<string>('apiKey') ?? undefined;
    this.mcpServer = createRelayMcpServer({
      apiKey,
      baseUrl: this.env.ENVIRONMENT === 'production'
        ? 'https://api.relaycast.dev'
        : undefined,
      telemetryTransport: 'http',
    });

    this.transport.onclose = () => {
      this.transport = null;
      this.mcpServer = null;
    };

    await this.mcpServer.connect(this.transport);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Store API key if provided via header (for pre-authenticated sessions).
    if (request.method === 'POST') {
      const apiKey = request.headers.get('x-relay-api-key');
      if (apiKey && !(await this.state.storage.get('apiKey'))) {
        await this.state.storage.put('apiKey', apiKey);
      }
    }

    // DELETE to close session.
    if (request.method === 'DELETE') {
      if (this.transport) {
        await this.transport.close();
        this.transport = null;
        this.mcpServer = null;
      }
      return new Response(null, { status: 204 });
    }

    await this.ensureInitialized();

    // Forward the request to the MCP transport.
    return this.transport!.handleRequest(request);
  }
}
