import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createHttpHandler, MCP_VERSION } from '@relaycast/mcp';
import { healthRouter } from './routes/health.js';
import { workspaceRouter } from './routes/workspace.js';
import { agentRouter } from './routes/agent.js';
import { channelRouter } from './routes/channel.js';
import { messageRouter } from './routes/message.js';
import { threadRouter } from './routes/thread.js';
import { dmRouter } from './routes/dm.js';
import { groupDmRouter } from './routes/groupDm.js';
import { reactionRouter } from './routes/reaction.js';
import { searchRouter } from './routes/search.js';
import { inboxRouter } from './routes/inbox.js';
import { receiptRouter } from './routes/receipt.js';
import { fileRouter } from './routes/file.js';
import { billingRouter } from './routes/billing.js';
import { webhookRouter } from './routes/webhooks.js';
import { presenceRouter } from './routes/presence.js';
import { systemPromptRouter } from './routes/systemPrompt.js';
import { inboundWebhookRouter } from './routes/inboundWebhook.js';
import { eventSubscriptionRouter } from './routes/eventSubscription.js';
import { commandRouter } from './routes/command.js';
import { dashboardRouter } from './routes/dashboard.js';

export const app = express();

app.use(cors());

// MCP routes — mounted BEFORE helmet() so cross-origin resource policy
// doesn't block Smithery's gateway or other MCP clients.
app.get('/.well-known/mcp/server-card.json', (_req: Request, res: Response) => {
  res.json({
    $schema: 'https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json',
    version: '1.0',
    protocolVersion: '2025-06-18',
    serverInfo: {
      name: 'relaycast',
      title: 'Relaycast',
      version: MCP_VERSION,
    },
    description: 'Headless Slack for AI agents. Channels, threads, DMs, reactions, file sharing, and real-time events.',
    iconUrl: 'https://relaycast.dev/favicon.svg',
    documentationUrl: 'https://github.com/AgentWorkforce/relaycast',
    transport: {
      type: 'streamable-http',
      endpoint: '/mcp',
    },
    capabilities: {
      tools: {},
      prompts: {},
      resources: { subscribe: true, listChanged: true },
    },
    authentication: {
      required: false,
    },
    configSchema: {
      type: 'object',
      properties: {
        apiKey: {
          type: 'string',
          title: 'Workspace API Key',
          description: 'Your Relaycast workspace key (rk_live_...). Optional — you can also authenticate via the set_workspace_key tool after connecting.',
          'x-from': { header: 'x-relay-api-key' },
        },
      },
    },
    tools: ['dynamic'],
    prompts: ['dynamic'],
    resources: ['dynamic'],
  });
});

// Smithery config schema discovery endpoint for external deployments.
// See: https://smithery.ai/docs/build/session-config
app.get('/.well-known/mcp-config', (_req: Request, res: Response) => {
  res.json({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: {
      relayApiKey: {
        type: 'string',
        title: 'Workspace API Key',
        description: 'Workspace API key (rk_live_...) used to pre-authenticate the MCP session. Optional — you can also authenticate via the set_workspace_key tool after connecting.',
      },
      relayBaseUrl: {
        type: 'string',
        title: 'API Base URL',
        description: 'Override API base URL for self-hosted Relaycast deployments.',
        default: 'https://api.relaycast.dev',
      },
    },
  });
});

// MCP Streamable HTTP endpoint — mounted BEFORE express.json() so the
// StreamableHTTPServerTransport can read the raw request body itself.
//
// Session affinity: MCP sessions hold live SSE connections in-memory and
// can't be serialized. When running multiple Fly.io machines, we register
// session→machine mappings in Redis. If a request arrives at the wrong
// machine, we reply with `fly-replay` so Fly's proxy re-routes it.
import { getRedis } from './redis/index.js';

const FLY_MACHINE_ID = process.env.FLY_MACHINE_ID;
const MCP_SESSION_TTL = 7200; // 2 hours

const mcpHandler = createHttpHandler(
  { baseUrl: process.env.RELAY_BASE_URL ?? 'https://api.relaycast.dev' },
  {
    onCreated: (sessionId) => {
      if (FLY_MACHINE_ID) {
        getRedis().set(`mcp:session:${sessionId}`, FLY_MACHINE_ID, 'EX', MCP_SESSION_TTL).catch(() => {});
      }
    },
    onClosed: (sessionId) => {
      if (FLY_MACHINE_ID) {
        getRedis().del(`mcp:session:${sessionId}`).catch(() => {});
      }
    },
  },
);

app.all('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  // --- Temporary MCP debug logging (remove after Smithery scanner is fixed) ---
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    const methods: string[] = [];
    try {
      const parsed = JSON.parse(body);
      if (Array.isArray(parsed)) {
        for (const r of parsed) methods.push(r.method ?? '?');
      } else {
        methods.push(parsed.method ?? '?');
      }
    } catch { /* not JSON */ }
    console.log(`[mcp-debug] ${req.method} session=${sessionId ?? 'none'} methods=[${methods.join(',')}] body=${body.length}B accept=${req.headers.accept}`);
  });
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  let totalBytes = 0;
  res.write = (chunk: unknown, ...args: unknown[]) => {
    if (Buffer.isBuffer(chunk)) totalBytes += chunk.length;
    else if (typeof chunk === 'string') totalBytes += Buffer.byteLength(chunk);
    return (origWrite as (...a: unknown[]) => boolean)(chunk, ...args);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (res as any).end = (chunk?: unknown, ...args: unknown[]) => {
    if (Buffer.isBuffer(chunk)) totalBytes += chunk.length;
    else if (typeof chunk === 'string') totalBytes += Buffer.byteLength(chunk);
    console.log(`[mcp-debug] response status=${res.statusCode} bytes=${totalBytes} content-type=${res.getHeader('content-type')}`);
    return (origEnd as (...a: unknown[]) => unknown)(chunk, ...args);
  };
  // --- End debug logging ---

  // Session exists locally or no session yet — handle directly
  if (!sessionId || mcpHandler.hasSession(sessionId)) {
    mcpHandler.handleRequest(req, res);
    return;
  }

  // Session not local — check Redis for the owning machine
  if (FLY_MACHINE_ID) {
    try {
      const ownerMachine = await getRedis().get(`mcp:session:${sessionId}`);
      if (ownerMachine && ownerMachine !== FLY_MACHINE_ID) {
        // Fly proxy intercepts this header and replays the request to the
        // correct machine, returning that machine's response to the client.
        res.setHeader('fly-replay', `instance=${ownerMachine}`);
        res.status(200).end();
        return;
      }
    } catch {
      // Redis unavailable — fall through and let the handler create a new session
    }
  }

  // Session doesn't exist anywhere — handler will create a new one
  mcpHandler.handleRequest(req, res);
});

app.use(helmet());
app.use(express.json({
  verify: (req, _res, buf) => {
    // Preserve raw body for Stripe webhook signature verification
    (req as Request & { rawBody?: Buffer }).rawBody = buf;
  },
}));

// Health check (outside /v1 prefix)
app.use('/health', healthRouter);

// API v1 routes — specific routes before parameterized routes
app.use('/v1', dashboardRouter);
app.use('/v1', presenceRouter);
app.use('/v1', systemPromptRouter);
app.use('/v1', workspaceRouter);
app.use('/v1', agentRouter);
app.use('/v1', channelRouter);
app.use('/v1', messageRouter);
app.use('/v1', threadRouter);
app.use('/v1', dmRouter);
app.use('/v1', groupDmRouter);
app.use('/v1', reactionRouter);
app.use('/v1', searchRouter);
app.use('/v1', inboxRouter);
app.use('/v1', receiptRouter);
app.use('/v1', fileRouter);
app.use('/v1', billingRouter);
app.use('/v1', webhookRouter);
app.use('/v1', inboundWebhookRouter);
app.use('/v1', eventSubscriptionRouter);
app.use('/v1', commandRouter);

// 404 handler for unknown routes
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    ok: false,
    error: { code: 'not_found', message: 'Route not found' },
  });
});

// Global error handler
app.use((err: Error & { type?: string; status?: number; code?: string }, _req: Request, res: Response, _next: NextFunction) => {
  if (err.type === 'entity.parse.failed') {
    res.status(400).json({
      ok: false,
      error: { code: 'invalid_json', message: 'Malformed JSON in request body' },
    });
    return;
  }

  const status = err.status || 500;
  res.status(status).json({
    ok: false,
    error: {
      code: err.code || 'internal_error',
      message: err.message || 'Internal server error',
    },
  });
});
