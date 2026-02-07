import { Response, NextFunction } from 'express';
import { type AuthenticatedRequest } from './auth.js';
import { getRedis } from '../redis/index.js';
import { publishEvent, type WsEvent } from '../ws/pubsub.js';

const PRESENCE_TTL = 60; // seconds

export async function presenceRefresh(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (req.agent && req.workspace) {
      const redis = getRedis();
      const key = `presence:${req.workspace.id}:${req.agent.id}`;

      const existed = await redis.exists(key);
      await redis.set(key, '1', 'EX', PRESENCE_TTL);

      if (!existed) {
        const event: WsEvent = {
          type: 'agent.online',
          workspace_id: req.workspace.id,
          data: { agent_id: req.agent.id, agent_name: req.agent.name },
          timestamp: new Date().toISOString(),
        };
        await publishEvent(event);
      }
    }
  } catch {
    // Don't block the request if presence refresh fails
  }
  next();
}
