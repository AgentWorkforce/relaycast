import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env.js';
import { agentDmAccessForChannelName, agentDmAccessForMessage } from '../engine/dmAccess.js';
import { jsonNotFound } from '../lib/httpResponse.js';

/**
 * Guards for routes that reach a conversation by channel name or message id.
 * DM and group-DM conversations live on ordinary channel rows, so without
 * these any agent token in the workspace could read or write another pair's
 * DM through the channel/message routes.
 *
 * Both run after the route's auth middleware and only constrain an agent
 * principal: a workspace key keeps full access and an observer token is
 * scoped by its own filters. An outsider gets the same 404 as a missing
 * resource so the routes do not confirm that a conversation exists.
 */

interface DmChannelGuardOptions {
  /**
   * Channel-membership operations (join, invite, leave) have no meaning on a
   * DM's backing channel: DM participants hold no `channel_members` row, so
   * join and invite would add one for a non-participant and leave would report
   * a departure that did not happen. They are refused for every agent,
   * participants included. Group DMs manage members through
   * `/dm/group/:id/participants`.
   */
  refuseParticipants?: boolean;
}

/** For `/channels/:name…` routes. */
export function hideDmChannelFromOutsiders(options: DmChannelGuardOptions = {}) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const agent = c.get('agent');
    const name = c.req.param('name');
    if (agent && name) {
      const access = await agentDmAccessForChannelName(c.get('db'), c.get('workspace').id, agent.id, name);
      if (access === 'outsider' || (access === 'participant' && options.refuseParticipants)) {
        return jsonNotFound(c, 'channel_not_found', `Channel "${name}" not found`);
      }
    }
    await next();
  });
}

/** For `/messages/:id…` routes. */
export const hideDmMessageFromOutsiders = createMiddleware<AppEnv>(async (c, next) => {
  const agent = c.get('agent');
  const messageId = c.req.param('id');
  if (agent && messageId) {
    const access = await agentDmAccessForMessage(c.get('db'), c.get('workspace').id, agent.id, messageId);
    if (access === 'outsider') {
      return jsonNotFound(c, 'message_not_found', 'Message not found');
    }
  }
  await next();
});
