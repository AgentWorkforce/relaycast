import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Relay, AgentClient } from '@relaycast/sdk';

/**
 * Register integration tools for unified agent authentication.
 * These tools enable agents to proxy requests, manage connections, and check access permissions.
 * API endpoints align with relay-cloud proxy service at /api/proxy/*.
 */
export function registerIntegrationTools(
  server: McpServer,
  getRelay: () => Relay,
  getAgentClient: () => AgentClient,
): void {
  // relay_proxy - Proxy HTTP requests through authenticated integrations
  server.registerTool(
    'relay_proxy',
    {
      description:
        'Proxy an HTTP request through an authenticated integration provider. ' +
        'Use this to make API calls to external services (GitHub, Slack, etc.) using stored credentials.',
      inputSchema: {
        provider: z.string().describe('Provider name (e.g. "github", "slack", "jira")'),
        method: z
          .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
          .describe('HTTP method'),
        endpoint: z.string().describe('API endpoint path (e.g. "/repos/owner/repo/issues")'),
        body: z
          .string()
          .optional()
          .describe('JSON-encoded request body for POST/PUT/PATCH'),
        params: z
          .string()
          .optional()
          .describe('JSON-encoded query parameters object'),
        headers: z
          .string()
          .optional()
          .describe('JSON-encoded additional headers object'),
      },
    },
    async ({ provider, method, endpoint, body, params, headers }) => {
      const client = getAgentClient();
      const parsedBody = body ? JSON.parse(body) : undefined;
      const parsedParams = params ? JSON.parse(params) : undefined;
      const parsedHeaders = headers ? JSON.parse(headers) : undefined;

      const result = await client.client.post(`/api/proxy/${provider}`, {
        method,
        endpoint,
        body: parsedBody,
        params: parsedParams,
        headers: parsedHeaders,
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // relay_connections - List available integration providers
  server.registerTool(
    'relay_connections',
    {
      description:
        'List all available integration providers and their connection status. ' +
        'Shows which services are connected and available for proxying.',
      inputSchema: {},
    },
    async () => {
      const relay = getRelay();
      const providers = await relay.client.get('/api/proxy/providers');

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(providers, null, 2) }],
      };
    },
  );

  // relay_can_access - Check if the current agent can access a provider scope
  server.registerTool(
    'relay_can_access',
    {
      description:
        'Check if the current agent has permission to access a provider with a specific scope. ' +
        'Use this to verify access before attempting proxy operations.',
      inputSchema: {
        provider: z.string().describe('Provider name (e.g. "github", "slack", "linear")'),
        scope: z
          .string()
          .optional()
          .describe('Scope to check access for (e.g. "repo", "read:user")'),
      },
    },
    async ({ provider, scope }) => {
      const client = getAgentClient();
      const queryParams = scope ? `?scope=${encodeURIComponent(scope)}` : '';

      const result = await client.client.get(`/api/proxy/${provider}/access${queryParams}`);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
