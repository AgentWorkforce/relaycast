import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
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
import { systemPromptRouter } from './routes/systemPrompt.js';
import { presenceRouter } from './routes/presence.js';
import { billingRouter } from './routes/billing.js';
import { webhookRouter } from './routes/webhooks.js';

export const app = express();

app.use(cors());
app.use(helmet());
app.use(express.json());

// Health check (outside /v1 prefix)
app.use('/health', healthRouter);

// API v1 routes
app.use('/v1', workspaceRouter);
// presenceRouter MUST be mounted BEFORE agentRouter because /agents/:name would capture /agents/presence
app.use('/v1', presenceRouter);
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
app.use('/v1', systemPromptRouter);
app.use('/v1', billingRouter);
app.use('/v1', webhookRouter);

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
