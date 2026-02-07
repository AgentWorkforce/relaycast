import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../auth.js';

const mockExists = vi.fn().mockResolvedValue(0);
const mockSet = vi.fn().mockResolvedValue('OK');
const mockPublish = vi.fn().mockResolvedValue(1);

vi.mock('../../redis/index.js', () => ({
  getRedis: vi.fn(() => ({
    exists: mockExists,
    set: mockSet,
  })),
}));

vi.mock('../../ws/pubsub.js', () => ({
  publishEvent: (...args: unknown[]) => mockPublish(...args),
}));

import { presenceRefresh } from '../presenceRefresh.js';

describe('presenceRefresh middleware', () => {
  let mockReq: Partial<AuthenticatedRequest>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    mockReq = {};
    mockRes = {};
    mockNext = vi.fn();
  });

  it('sets presence key on agent token request', async () => {
    mockReq.agent = { id: 'agent_1', workspaceId: 'ws_1', name: 'TestBot' } as AuthenticatedRequest['agent'];
    mockReq.workspace = { id: 'ws_1' } as AuthenticatedRequest['workspace'];
    mockExists.mockResolvedValue(1); // already online

    await presenceRefresh(mockReq as AuthenticatedRequest, mockRes as Response, mockNext);

    expect(mockSet).toHaveBeenCalledWith('presence:ws_1:agent_1', '1', 'EX', 60);
    expect(mockNext).toHaveBeenCalled();
  });

  it('emits agent.online event when newly online', async () => {
    mockReq.agent = { id: 'agent_1', workspaceId: 'ws_1', name: 'TestBot' } as AuthenticatedRequest['agent'];
    mockReq.workspace = { id: 'ws_1' } as AuthenticatedRequest['workspace'];
    mockExists.mockResolvedValue(0); // not previously online

    await presenceRefresh(mockReq as AuthenticatedRequest, mockRes as Response, mockNext);

    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent.online',
        workspace_id: 'ws_1',
        data: { agent_id: 'agent_1', agent_name: 'TestBot' },
      }),
    );
    expect(mockNext).toHaveBeenCalled();
  });

  it('does not emit event when already online', async () => {
    mockReq.agent = { id: 'agent_1', workspaceId: 'ws_1', name: 'TestBot' } as AuthenticatedRequest['agent'];
    mockReq.workspace = { id: 'ws_1' } as AuthenticatedRequest['workspace'];
    mockExists.mockResolvedValue(1); // already online

    await presenceRefresh(mockReq as AuthenticatedRequest, mockRes as Response, mockNext);

    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockNext).toHaveBeenCalled();
  });

  it('skips presence for non-agent requests', async () => {
    mockReq.workspace = { id: 'ws_1' } as AuthenticatedRequest['workspace'];
    // No agent set (workspace key auth)

    await presenceRefresh(mockReq as AuthenticatedRequest, mockRes as Response, mockNext);

    expect(mockSet).not.toHaveBeenCalled();
    expect(mockNext).toHaveBeenCalled();
  });

  it('calls next even if presence refresh fails', async () => {
    mockReq.agent = { id: 'agent_1', workspaceId: 'ws_1', name: 'TestBot' } as AuthenticatedRequest['agent'];
    mockReq.workspace = { id: 'ws_1' } as AuthenticatedRequest['workspace'];
    mockExists.mockRejectedValue(new Error('Redis connection error'));

    await presenceRefresh(mockReq as AuthenticatedRequest, mockRes as Response, mockNext);

    expect(mockNext).toHaveBeenCalled();
  });
});
