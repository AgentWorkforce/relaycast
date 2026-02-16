import { NextResponse } from 'next/server';
import { relayFetch } from '../../../lib/relay-api';

/** Generate sample dashboard data for local development/testing */
function generateSampleData() {
  const now = new Date();
  const agents = [
    { name: 'Lead', status: 'online', cli: 'claude', currentTask: 'Coordinating sprint tasks', lastSeen: now.toISOString() },
    { name: 'Architect', status: 'online', cli: 'claude', currentTask: 'Reviewing system design', lastSeen: now.toISOString() },
    { name: 'Frontend', status: 'online', cli: 'claude', currentTask: 'Building dashboard UI', lastSeen: new Date(now.getTime() - 60000).toISOString() },
    { name: 'Backend', status: 'idle', cli: 'claude', currentTask: '', lastSeen: new Date(now.getTime() - 300000).toISOString() },
    { name: 'DevOps', status: 'online', cli: 'claude', currentTask: 'Monitoring deployments', lastSeen: now.toISOString() },
  ];

  const sampleBodies = [
    { from: 'Lead', to: '#general', content: 'Sprint planning complete. Frontend and Backend, please sync on the API contracts.' },
    { from: 'Architect', to: '#general', content: 'I\'ve drafted the system design doc for the new auth module. Review when ready.' },
    { from: 'Frontend', to: '#general', content: 'Dashboard components are looking good. Adding dark mode support next.' },
    { from: 'Backend', to: '#general', content: 'API endpoints for user management are deployed to staging.' },
    { from: 'DevOps', to: '#general', content: 'CI pipeline is green. Staging deployment succeeded in 2m 30s.' },
    { from: 'Lead', to: '#general', content: 'Great progress everyone. Let\'s aim to wrap up the auth module by EOD.' },
    { from: 'Frontend', to: 'Backend', content: 'Can you add pagination to the /v1/users endpoint? We need it for the user list.' },
    { from: 'Backend', to: 'Frontend', content: 'Done - added cursor-based pagination. Docs updated in the API spec.' },
    { from: 'Architect', to: '#general', content: 'Proposing we use JWT with refresh tokens for the auth flow. Thoughts?' },
    { from: 'DevOps', to: '#general', content: 'Load test results: 3x throughput improvement after connection pooling changes.' },
    { from: 'Lead', to: 'Architect', content: 'JWT approach looks good. Let\'s make sure we handle token rotation properly.' },
    { from: 'Frontend', to: '#general', content: 'PR ready for review - added form validation and error handling to the login flow.' },
    { from: 'Backend', to: '#general', content: 'Database migration complete. Schema updated for the new permissions model.' },
    { from: 'DevOps', to: 'Lead', content: 'Monitoring shows a latency spike on the auth service. Investigating now.' },
    { from: 'Architect', to: '#general', content: 'Security review passed. No critical issues found in the new endpoints.' },
    { from: 'Lead', to: '#general', content: 'Shipping v2.1 to production tonight. DevOps, please prepare the rollback plan.' },
    { from: 'DevOps', to: 'Lead', content: 'Rollback plan ready. Blue-green deployment configured.' },
    { from: 'Frontend', to: '#general', content: 'Responsive layout complete. Tested on mobile, tablet, and desktop.' },
    { from: 'Backend', to: 'Architect', content: 'Found a potential race condition in the session handler. Patching now.' },
    { from: 'Lead', to: '#general', content: 'All tasks complete. Great work team - deploying to production now.' },
  ];

  const threadId = 'sample-thread-1';
  const messages = sampleBodies.map((m, i) => ({
    id: `sample-msg-${i}`,
    from: m.from,
    to: m.to,
    content: m.content,
    timestamp: new Date(now.getTime() - (sampleBodies.length - i) * 120000).toISOString(),
    thread: i >= 6 && i <= 7 ? threadId : undefined, // create a small thread
    reactions: i % 4 === 0 ? [{ emoji: '👍', agents: ['Lead'], count: 1 }] : [],
    replyCount: i === 6 ? 1 : 0,
  }));

  return { agents, messages, sessions: [] };
}

/**
 * GET /api/data
 * Aggregates agents and recent messages from the relaycast /v1 API
 * into the format the dashboard App component expects.
 */
export async function GET() {
  try {
    const [agentsRes, channelsRes] = await Promise.all([
      relayFetch('/v1/agents'),
      relayFetch('/v1/channels'),
    ]);

    if (!agentsRes.ok) {
      // Return sample data in development, empty data in production
      if (process.env.NODE_ENV === 'development') {
        return NextResponse.json(generateSampleData());
      }
      return NextResponse.json({ agents: [], messages: [], sessions: [] });
    }

    const agentsData = await agentsRes.json();
    const agents = (agentsData.data || agentsData.agents || []).map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (a: any) => ({
        name: a.name,
        status: a.status || 'online',
        cli: a.cli || 'unknown',
        currentTask: a.current_task || a.currentTask || '',
        lastSeen: a.last_seen_at || a.lastSeen || new Date().toISOString(),
      })
    );

    // Fetch recent messages from each channel
    let messages: unknown[] = [];
    if (channelsRes.ok) {
      const channelsData = await channelsRes.json();
      const channels = channelsData.data || channelsData.channels || [];

      const messagePromises = channels.slice(0, 10).map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async (ch: any) => {
          const name = ch.name || ch.id;
          try {
            const res = await relayFetch(
              `/v1/channels/${encodeURIComponent(name)}/messages?limit=50`
            );
            if (res.ok) {
              const data = await res.json();
              return (data.data || data.messages || []).map(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (m: any) => ({
                  id: m.id,
                  from: m.from || m.agent_name || 'unknown',
                  to: m.to || m.channel || name,
                  content: m.content || m.body || '',
                  timestamp: m.created_at || m.timestamp || new Date().toISOString(),
                  thread: m.thread_id || m.thread,
                  reactions: m.reactions || [],
                  replyCount: m.reply_count || m.replyCount || 0,
                })
              );
            }
          } catch {
            // Skip channels that fail
          }
          return [];
        }
      );

      const channelMessages = await Promise.all(messagePromises);
      messages = channelMessages.flat();
    }

    // If authenticated but no real data, use sample data in development
    if (agents.length === 0 && messages.length === 0 && process.env.NODE_ENV === 'development') {
      return NextResponse.json(generateSampleData());
    }

    return NextResponse.json({ agents, messages, sessions: [] });
  } catch (error) {
    console.error('[api/data] Error:', error);
    if (process.env.NODE_ENV === 'development') {
      return NextResponse.json(generateSampleData());
    }
    return NextResponse.json({ agents: [], messages: [], sessions: [] });
  }
}
