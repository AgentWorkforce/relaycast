import { z } from 'zod';
import { createRelayMcpServer } from './server.js';

/**
 * Smithery config schema – exposed to the Smithery registry so it can
 * auto-generate a configuration form and validate user input.
 *
 * Both fields are optional: callers can set a workspace key at runtime
 * via the `set_workspace_key` / `create_workspace` tools instead.
 */
export const configSchema = z.object({
  relayApiKey: z
    .string()
    .optional()
    .describe(
      'Workspace API key (rk_live_...) used to pre-authenticate the MCP session.',
    ),
  relayBaseUrl: z
    .string()
    .optional()
    .describe(
      'Override API base URL for self-hosted Relaycast deployments (defaults to https://gateway.relaycast.dev).',
    ),
});

/**
 * Smithery entry point.
 *
 * Smithery calls this function with validated config and expects a
 * low-level `Server` instance from @modelcontextprotocol/sdk.
 */
export default function createServer(context: {
  config: z.infer<typeof configSchema>;
}) {
  const mcpServer = createRelayMcpServer({
    apiKey: context.config.relayApiKey,
    baseUrl: context.config.relayBaseUrl,
    telemetryTransport: 'stdio',
  });

  return mcpServer.server;
}
