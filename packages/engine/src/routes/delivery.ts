import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { requireAgentToken, requireWorkspaceRead } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as deliveryEngine from '../engine/delivery.js';
import { notifySenderDeliveryReceipts } from '../engine/deliveryReceipts.js';
import {
  getMessageObserverResource,
  getObserverTokenFromContext,
  observerAllowsMessageResource,
} from '../engine/observerToken.js';
import { fanoutToAgents } from './fanout.js';
import { runInBackground } from './background.js';
import { errorResponse } from '../lib/httpError.js';
import {
  jsonNotFound,
  jsonOk,
  parseJsonBody,
  parseOptionalJsonBody,
  parseQueryParams,
} from '../lib/httpResponse.js';
import { resolveWorkspaceDeliveryPolicyFor, WorkspaceDeliveryCapacityError } from '../engine/workspaceDeliveryPolicy.js';
import { ListDeliveriesQuerySchema, FailDeliveryRequestSchema, DeferDeliveryRequestSchema } from '@relaycast/types';

export const deliveryRoutes = new Hono<AppEnv>();

// GET /v1/deliveries - durable delivery queue for the calling agent.
// Defaults to non-terminal items (queued + delivered) so offline consumers
// can replay what they missed after reconnect. `wait` (ms) long-polls: an
// empty answer is held until a delivery is created for the agent, the wait
// expires or the client goes away. A parked request reads nothing; when woken
// it lists again with the same query and parks again if that is still empty.
deliveryRoutes.get(
  '/deliveries',
  requireAgentToken,
  rateLimit,
  async (c) => {
    try {
      const parsed = parseQueryParams(c, ListDeliveriesQuerySchema, 'Invalid status, limit or wait');
      if (!parsed.ok) {
        return parsed.response;
      }
      const db = c.get('db');
      const workspace = c.get('workspace');
      const agent = c.get('agent');
      const { wait, ...query } = parsed.data;
      const waiters = c.get('engine').deliveryWaiters;
      const deadline = Date.now() + (wait ?? 0);
      for (;;) {
        const since = Date.now();
        const result = await deliveryEngine.listDeliveries(db, workspace.id, agent!.id, query);
        const remaining = deadline - Date.now();
        if (result.length > 0 || !waiters || remaining <= 0) return jsonOk(c, result);
        const outcome = await waiters.wait({
          workspaceId: workspace.id,
          agentId: agent!.id,
          since,
          timeoutMs: remaining,
          signal: c.req.raw.signal,
        });
        if (outcome === 'timeout') return jsonOk(c, result);
      }
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);

// GET /v1/deliveries/by-message/:messageId - pending delivery proof for this
// exact recipient. An acked, expired, foreign, or absent message is the same 404.
deliveryRoutes.get(
  '/deliveries/by-message/:messageId',
  requireAgentToken,
  rateLimit,
  async (c) => {
    try {
      const result = await deliveryEngine.pendingDeliveryForMessage(
        c.get('db'), c.get('workspace').id, c.get('agent')!.id, c.req.param('messageId'),
      );
      return result ? jsonOk(c, result) : jsonNotFound(c, 'delivery_not_found', 'Delivery not found');
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);

// POST /v1/deliveries/:id/ack - idempotently mark a delivery acked.
deliveryRoutes.post(
  '/deliveries/:id/ack',
  requireAgentToken,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const agent = c.get('agent');
      const id = c.req.param('id');
      const result = await deliveryEngine.ackDelivery(db, workspace.id, agent!.id, id);
      if (!result) {
        return jsonNotFound(c, 'delivery_not_found', 'Delivery not found');
      }
      // Only fan out when this call actually transitioned the delivery, so
      // idempotent retries don't emit duplicate notifications. The recipient
      // keeps its `delivery.delivered`; the sender learns of the ack.
      if (result.changed) {
        runInBackground(
          c,
          fanoutToAgents(c, [agent!.id], 'delivery.delivered', {
            delivery_id: result.delivery.id,
            message_id: result.delivery.message_id,
          }),
          'fanout delivery.delivered',
        );
        runInBackground(
          c,
          notifySenderDeliveryReceipts({ db, engine: c.get('engine') }, workspace.id, [result.delivery.id], 'acked'),
          'notify sender delivery.acked',
        );
      }
      return jsonOk(c, result.delivery);
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);

// GET /v1/messages/:id/deliveries - the sender's view of a message's deliveries.
// A workspace key or an observer token with `messages:read` / `dms:read` (and
// filters that admit the message) reads any message; an agent token reads
// only messages it sent. Any other agent gets `message_not_found`, like
// `POST /v1/messages/:id/read`, so the route reveals nothing about messages
// the caller did not send. Node tokens are refused.
deliveryRoutes.get(
  '/messages/:id/deliveries',
  requireWorkspaceRead(['messages:read', 'dms:read'], { allowNode: false }),
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const agent = c.get('agent');
      const messageId = c.req.param('id');
      const observer = getObserverTokenFromContext(c);
      if (observer) {
        const resource = await getMessageObserverResource(db, workspace.id, messageId);
        if (!resource || !observerAllowsMessageResource(observer, resource, { normalScope: 'messages:read' })) {
          return jsonNotFound(c, 'message_not_found', 'Message not found');
        }
      }
      const result = await deliveryEngine.getMessageDeliveries(db, workspace.id, messageId);
      if (!result || (agent && result.sender_agent_id !== agent.id)) {
        return jsonNotFound(c, 'message_not_found', 'Message not found');
      }
      return jsonOk(c, { message_id: result.message_id, deliveries: result.deliveries });
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);

// POST /v1/deliveries/:id/fail - idempotently record a failed delivery.
deliveryRoutes.post(
  '/deliveries/:id/fail',
  requireAgentToken,
  rateLimit,
  async (c) => {
    try {
      const parsed = await parseOptionalJsonBody(
        c,
        FailDeliveryRequestSchema,
        'Invalid fail payload',
        { malformedBodyError: { code: 'invalid_request', message: 'Invalid JSON body' } },
      );
      if (!parsed.ok) {
        return parsed.response;
      }
      const db = c.get('db');
      const workspace = c.get('workspace');
      const agent = c.get('agent');
      const id = c.req.param('id');
      const result = await deliveryEngine.failDelivery(db, workspace.id, agent!.id, id, parsed.data);
      if (!result) {
        return jsonNotFound(c, 'delivery_not_found', 'Delivery not found');
      }
      if (result.changed) {
        runInBackground(
          c,
          fanoutToAgents(c, [agent!.id], 'delivery.failed', {
            delivery_id: result.delivery.id,
            message_id: result.delivery.message_id,
            error: result.delivery.error,
            retryable: result.delivery.retryable,
          }),
          'fanout delivery.failed',
        );
      }
      return jsonOk(c, result.delivery);
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);

// POST /v1/deliveries/:id/defer - idempotently defer a delivery to available_at.
deliveryRoutes.post(
  '/deliveries/:id/defer',
  requireAgentToken,
  rateLimit,
  async (c) => {
    try {
      const parsed = await parseJsonBody(
        c,
        DeferDeliveryRequestSchema,
        'available_at must be an ISO-8601 timestamp',
        {
          malformedBodyError: {
            code: 'invalid_request',
            message: 'available_at must be an ISO-8601 timestamp',
          },
        },
      );
      if (!parsed.ok) {
        return parsed.response;
      }
      const db = c.get('db');
      const workspace = c.get('workspace');
      const agent = c.get('agent');
      const id = c.req.param('id');
      let result: Awaited<ReturnType<typeof deliveryEngine.deferDelivery>>;
      try {
        result = await deliveryEngine.deferDelivery(db, workspace.id, agent!.id, id, {
          availableAt: new Date(parsed.data.available_at),
          reason: parsed.data.reason,
          workspacePolicy: await resolveWorkspaceDeliveryPolicyFor(c.get('engine').config, workspace),
        });
      } catch (error) {
        if (error instanceof WorkspaceDeliveryCapacityError) {
          return errorResponse(c, error);
        }
        throw error;
      }
      if (!result) {
        return jsonNotFound(c, 'delivery_not_found', 'Delivery not found');
      }
      if (result.changed) {
        runInBackground(
          c,
          fanoutToAgents(c, [agent!.id], 'delivery.deferred', {
            delivery_id: result.delivery.id,
            message_id: result.delivery.message_id,
            available_at: result.delivery.available_at,
            reason: result.delivery.reason,
          }),
          'fanout delivery.deferred',
        );
      }
      return jsonOk(c, result.delivery);
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);
