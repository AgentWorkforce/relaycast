/**
 * MCP (Model Context Protocol) stateful-session host — replaces McpSessionDO.
 *
 * The session-id strategy is owned entirely by the adapter. Cloudflare derives
 * it from `state.id.toString()` (hex) and routes back via `idFromString`; Node
 * generates a `crypto.randomUUID()` and holds the transport in a `Map`. An
 * unknown/evicted session id returns the same 404 on both, so the engine route
 * only ever forwards the `mcp-session-id` header and never assumes its shape.
 */
export interface McpSessionHost {
  /**
   * Route an MCP Streamable-HTTP request to its stateful session, creating one
   * when `sessionId` is undefined (the `initialize` call). Returns the full
   * `Response` (including the assigned `mcp-session-id` header on creation).
   */
  handle(request: Request, sessionId: string | undefined): Promise<Response>;
}
