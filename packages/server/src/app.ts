import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { healthRouter } from './routes/health.js';
import { workspaceRouter } from './routes/workspace.js';
import { agentRouter } from './routes/agent.js';
import { channelRouter } from './routes/channel.js';

export const app = express();

app.use(cors());
app.use(helmet());
app.use(express.json());

// Health check (outside /v1 prefix)
app.use('/health', healthRouter);

// API v1 routes
app.use('/v1', workspaceRouter);
app.use('/v1', agentRouter);
app.use('/v1', channelRouter);

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
