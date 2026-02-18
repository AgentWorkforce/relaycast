import type { Agent, Message, ActivityEvent } from '../types/dashboard';

export function synthesizeActivityEvents(
  agents: Agent[],
  messages: Message[]
): ActivityEvent[] {
  const events: ActivityEvent[] = [];

  // Messages → message_sent events
  for (const msg of messages) {
    events.push({
      id: `msg-${msg.id}`,
      type: 'message_sent',
      summary: `${msg.from} sent a message in ${msg.to}`,
      timestamp: msg.timestamp,
      agent: msg.from,
    });

    // Reactions → reaction events
    for (const reaction of (msg.reactions ?? [])) {
      const agentNames = Array.isArray(reaction.agents) ? reaction.agents : [];
      if (agentNames.length > 0) {
        for (const agent of agentNames) {
          events.push({
            id: `react-${msg.id}-${reaction.emoji}-${agent}`,
            type: 'reaction',
            summary: `${agent} reacted ${reaction.emoji} to ${msg.from}'s message`,
            timestamp: msg.timestamp,
            agent,
          });
        }
      } else if (reaction.count > 0) {
        // Server returned count without agent names
        events.push({
          id: `react-${msg.id}-${reaction.emoji}`,
          type: 'reaction',
          summary: `${reaction.count} ${reaction.emoji} on ${msg.from}'s message`,
          timestamp: msg.timestamp,
          agent: msg.from,
        });
      }
    }

    // Thread replies — show individual reply events when we have reply data
    if (msg.replyCount > 0 && msg.replies && msg.replies.length > 0) {
      for (const reply of msg.replies) {
        events.push({
          id: `reply-${msg.id}-${reply.from}`,
          type: 'thread_reply',
          summary: `${reply.from} replied in ${msg.from}'s thread`,
          timestamp: reply.timestamp || msg.timestamp,
          agent: reply.from,
        });
      }
    } else if (msg.replyCount > 0) {
      events.push({
        id: `reply-${msg.id}`,
        type: 'thread_reply',
        summary: `${msg.replyCount} ${msg.replyCount === 1 ? 'reply' : 'replies'} in ${msg.from}'s thread`,
        timestamp: msg.timestamp,
        agent: msg.from,
      });
    }
  }

  // Agents → connection / idle events
  for (const agent of agents) {
    if (agent.status === 'online') {
      events.push({
        id: `conn-${agent.name}`,
        type: 'connection',
        summary: `${agent.name} is online`,
        timestamp: agent.lastSeen,
        agent: agent.name,
      });
    } else if (agent.status === 'idle') {
      events.push({
        id: `idle-${agent.name}`,
        type: 'agent_idle',
        summary: `${agent.name} went idle`,
        timestamp: agent.lastSeen,
        agent: agent.name,
      });
    }
  }

  // Sort by timestamp ascending (chronological), cap at 200
  events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return events.slice(0, 200);
}
