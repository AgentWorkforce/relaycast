#!/usr/bin/env npx tsx
/**
 * Relaycast end-to-end smoke test.
 *
 * Exercises every major feature against a running server so you can watch
 * messages flow in both the terminal and the dashboard.
 *
 * Usage:
 *   npm run e2e -- http://localhost:8787          # interactive — pauses after workspace creation
 *   npm run e2e -- http://localhost:8787 --ci     # auto mode — no pauses, for CI
 *   npm run e2e -- https://relaycast.dev --ci
 */

import { createInterface } from 'node:readline';
import { RelayCast, AgentClient, RelayError } from '../packages/sdk-typescript/src/index.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const BASE_URL = (args[0] ?? 'http://localhost:8787').replace(/\/+$/, '');
const CI = flags.has('--ci') || !!process.env.CI;

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host.endsWith('.localhost');
}

function resolveDashboardUrl(baseUrl: string): string {
  let host = '';
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return 'http://localhost:3100';
  }

  if (!host || isLocalHost(host)) {
    return 'http://localhost:3100';
  }

  const prMatch = host.match(/^pr(\d+)-api(?:[.-]|$)/);
  if (prMatch) {
    return `https://pr${prMatch[1]}-observer.relaycast.dev`;
  }

  if (host === 'staging-api.relaycast.dev') {
    return 'https://staging-observer.relaycast.dev';
  }

  if (host === 'api.relaycast.dev') {
    return 'https://observer.relaycast.dev';
  }

  return 'https://observer.relaycast.dev';
}

// ---------------------------------------------------------------------------
// Terminal colors
// ---------------------------------------------------------------------------
const R = '\x1b[0m';
const B = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';

function ts() {
  return `${DIM}${new Date().toISOString().slice(11, 23)}${R}`;
}

function log(icon: string, msg: string) {
  console.log(`${ts()} ${icon} ${msg}`);
}

function step(label: string) {
  console.log(`\n${ts()} ${YELLOW}${B}▸ ${label}${R}`);
}

function ok(msg: string) {
  log('✅', `${GREEN}${msg}${R}`);
}

function ws(agent: string, event: string, detail: string) {
  log('⚡', `${DIM}[WS → ${agent}]${R} ${MAGENTA}${event}${R} ${detail}`);
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** Random delay to make the run feel more realistic. */
function pause() {
  const ms = CI
    ? 200 + Math.random() * 300   // 200–500ms in CI
    : 1000 + Math.random() * 3000; // 1–4s interactive
  return sleep(ms);
}

function waitForEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Agent names & colors
// ---------------------------------------------------------------------------
const LEAD = 'LeadAgent';
const INFRA = 'InfraAgent';
const BACKEND = 'BackendAgent';

const colors: Record<string, string> = {
  [LEAD]: YELLOW,
  [INFRA]: GREEN,
  [BACKEND]: BLUE,
};

// ---------------------------------------------------------------------------
// Deterministic conversation — Lead assigns tasks, agents report back
// ---------------------------------------------------------------------------
const CHANNEL_MESSAGES: Array<{ from: string; text: string }> = [
  { from: LEAD, text: `@${INFRA} @${BACKEND} — standup time. What are you working on?` },
  { from: INFRA, text: 'Looking into the flaky staging deploys. Health check timeouts are too aggressive.' },
  { from: BACKEND, text: 'Wrapping up the test coverage report for the message pipeline.' },
  { from: LEAD, text: `@${INFRA} Bump the health check timeout to 30s and add a retry. Priority 1.` },
  { from: INFRA, text: 'On it. I will push the fix within the hour.' },
  { from: LEAD, text: `@${BACKEND} Once InfraAgent's fix is up, run the full integration suite against staging.` },
  { from: BACKEND, text: 'Will do. I will watch for the deploy and kick off the suite.' },
  { from: INFRA, text: 'Fix is pushed. Staging deploy rolling out now.' },
  { from: BACKEND, text: 'Integration suite passed — all 247 tests green.' },
  { from: LEAD, text: 'Great work team. Merging to main.' },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`
${B}${CYAN}╔══════════════════════════════════════════════╗
║          Relaycast E2E Smoke Test            ║
╚══════════════════════════════════════════════╝${R}
`);
  log('🌐', `Server: ${B}${BASE_URL}${R}`);
  log('⚙️ ', `Mode:   ${B}${CI ? 'CI (auto)' : 'Interactive'}${R}`);

  let workspaceKey = '';
  let relay!: RelayCast;
  let lead!: AgentClient;
  let infra!: AgentClient;
  let backend!: AgentClient;
  const passed: string[] = [];
  const failed: string[] = [];
  const channelName = 'engineering';

  async function run(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      ok(name);
      passed.push(name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('❌', `${RED}${name}: ${msg}${R}`);
      failed.push(name);
    }
  }

  async function waitForConnected(name: string, client: AgentClient, timeoutMs = 15000): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let offOpen: () => void = () => {};
      let offError: () => void = () => {};
      let offClose: () => void = () => {};
      let errors = 0;
      let closes = 0;
      const cleanup = (subs: Array<() => void>, timer: ReturnType<typeof setTimeout>) => {
        subs.forEach((off) => off());
        clearTimeout(timer);
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup([offOpen, offError, offClose], timer);
        reject(new Error(`${name} websocket connect timeout after ${timeoutMs}ms (errors=${errors}, closes=${closes})`));
      }, timeoutMs);

      offOpen = client.on.connected(() => {
        if (settled) return;
        settled = true;
        cleanup([offOpen, offError, offClose], timer);
        resolve();
      });

      offError = client.on.error(() => {
        if (settled) return;
        errors++;
      });

      offClose = client.on.disconnected(() => {
        if (settled) return;
        closes++;
      });
    });
  }

  // ── 1. Create workspace ──────────────────────────────────────────────
  step('Create workspace');
  await run('Create workspace', async () => {
    const wsName = `e2e-${Date.now()}`;
    const res = await RelayCast.createWorkspace(wsName, BASE_URL);
    workspaceKey = res.apiKey;
    relay = new RelayCast({ apiKey: workspaceKey, baseUrl: BASE_URL });
    log('🔑', `Workspace ${B}${wsName}${R} — key: ${DIM}${workspaceKey.slice(0, 16)}…${R}`);
  });

  if (!CI) {
    const dashboardUrl = resolveDashboardUrl(BASE_URL);
    const dashboardLabel =
      dashboardUrl === 'http://localhost:3100'
        ? 'Open the dashboard'
        : 'Open the hosted observer dashboard';
    console.log();
    log('📊', `${dashboardLabel}: ${B}${CYAN}${dashboardUrl}${R}`);
    log('🔑', `Workspace key: ${B}${workspaceKey}${R}`);
    console.log();
    await waitForEnter(`${YELLOW}${B}  Press Enter to start the test run...${R} `);
  } else {
    await pause();
  }

  // ── 2. Register agents ───────────────────────────────────────────────
  step('Register agents');

  await run(`Register ${LEAD}`, async () => {
    const res = await relay.agents.register({
      name: LEAD,
      type: 'agent',
      persona: 'Engineering team lead. Coordinates InfraAgent and BackendAgent, assigns tasks, and unblocks the team.',
      metadata: { cli: 'claude' },
    });
    lead = relay.as(res.token);
    log('🤖', `${YELLOW}${B}${LEAD}${R} registered`);
  });

  await run(`Register ${INFRA}`, async () => {
    const res = await relay.agents.register({
      name: INFRA,
      type: 'agent',
      persona: 'Senior infrastructure engineer. Owns CI/CD pipelines, deploys, health checks, and cloud resources.',
      metadata: { cli: 'claude' },
    });
    infra = relay.as(res.token);
    log('🤖', `${GREEN}${B}${INFRA}${R} registered`);
  });

  await run(`Register ${BACKEND}`, async () => {
    const res = await relay.agents.register({
      name: BACKEND,
      type: 'agent',
      persona: 'Backend developer focused on testing, reliability, and the message pipeline.',
      metadata: { cli: 'claude' },
    });
    backend = relay.as(res.token);
    log('🤖', `${BLUE}${B}${BACKEND}${R} registered`);
  });

  await pause();

  const agentMap: Record<string, AgentClient> = {
    [LEAD]: lead,
    [INFRA]: infra,
    [BACKEND]: backend,
  };

  // ── 2a. Strict identity & error normalization ───────────────────────
  step('Strict identity & error normalization');

  await run('Duplicate registration with strict mode throws name_conflict', async () => {
    try {
      await relay.registerAgent({ name: LEAD, strict: true });
      throw new Error('Expected RelayError but registration succeeded');
    } catch (err) {
      if (!(err instanceof RelayError)) throw new Error(`Expected RelayError, got ${(err as Error).constructor.name}`);
      if (err.code !== 'name_conflict') throw new Error(`Expected code 'name_conflict', got '${err.code}'`);
      log('🛡️ ', `Strict duplicate correctly threw RelayError(code=${err.code}, rawCode=${err.rawCode})`);
    }
  });

  await run('registerAgent non-strict appends suffix', async () => {
    const res = await relay.registerAgent({ name: LEAD, strict: false });
    if (res.name === LEAD) throw new Error(`Expected suffixed name, got exact '${LEAD}'`);
    if (!res.name.startsWith(LEAD)) throw new Error(`Expected name starting with '${LEAD}', got '${res.name}'`);
    log('🛡️ ', `Non-strict duplicate registered as ${B}${res.name}${R} (suffix appended)`);
  });

  // ── 2b. registerOrRotate + resolveIdentity ─────────────────────────
  step('registerOrRotate + resolveIdentity');

  await run('registerOrRotate returns valid token', async () => {
    const res = await relay.registerOrRotate({ name: LEAD, type: 'agent' });
    if (!res.token) throw new Error('Expected token from registerOrRotate');
    // Update lead client with rotated token (old token is now invalid)
    lead = relay.as(res.token);
    agentMap[LEAD] = lead;
    const channels = await lead.channels.list();
    log('🔑', `registerOrRotate returned token, verified with list channels (${channels.length} channels)`);
  });

  await run('resolveIdentity returns identity fields', async () => {
    const identity = await relay.resolveIdentity();
    if (!identity.agentId) throw new Error('Expected agentId in resolved identity');
    if (!identity.name) throw new Error('Expected name in resolved identity');
    if (!identity.workspaceId) throw new Error('Expected workspaceId in resolved identity');
    log('🔑', `Resolved identity: ${B}${identity.name}${R} (agent=${identity.agentId}, ws=${identity.workspaceId})`);
  });

  await pause();

  // ── 3. Create channel + join ─────────────────────────────────────────
  step('Create channel');
  await run('Create #engineering', async () => {
    await lead.channels.create({ name: channelName, topic: 'Engineering coordination' });
    log('📢', `Channel ${B}#${channelName}${R} created by ${LEAD}`);
  });

  await run(`${INFRA} joins #engineering`, async () => {
    await infra.channels.join(channelName);
    log('👋', `${GREEN}${B}${INFRA}${R} joined #${channelName}`);
  });

  await run(`${BACKEND} joins #engineering`, async () => {
    await backend.channels.join(channelName);
    log('👋', `${BLUE}${B}${BACKEND}${R} joined #${channelName}`);
  });

  // ── 4. Connect WebSockets ────────────────────────────────────────────
  step('Connect WebSockets');

  let wsEvents = 0;

  await run('WebSocket connect + subscribe', async () => {
    lead.connect();
    infra.connect();
    backend.connect();

    await Promise.all([
      waitForConnected(LEAD, lead),
      waitForConnected(INFRA, infra),
      waitForConnected(BACKEND, backend),
    ]);

    // Listen for events on all agents
    for (const [name, client] of Object.entries(agentMap)) {
      client.on.messageCreated((e) => { wsEvents++; ws(name, 'message.created', `from ${B}${e.message.agentName}${R}: "${e.message.text}"`); });
      client.on.dmReceived((e) => { wsEvents++; ws(name, 'dm.received', `from ${B}${e.message.agentName}${R}: "${e.message.text}"`); });
      client.on.reactionAdded((e) => { wsEvents++; ws(name, 'reaction.added', `${e.emoji}`); });
      client.on.channelUpdated(() => { wsEvents++; ws(name, 'channel.updated', ''); });
    }

    lead.subscribe(['general', channelName]);
    infra.subscribe(['general', channelName]);
    backend.subscribe(['general', channelName]);

    log('🔌', `All agents connected & subscribed to #general and #${channelName}`);
  });

  await pause();

  // ── 5. Hello world in #general ─────────────────────────────────────
  step('Post to #general');
  await run(`${LEAD} says hello in #general`, async () => {
    await lead.channels.join('general');
    await infra.channels.join('general');
    await backend.channels.join('general');
    log('📤', `${YELLOW}${B}${LEAD}${R}: Hello, world! All agents online.`);
    await lead.send('general', 'Hello, world! All agents online.');
  });
  await pause();

  // ── 6. Channel conversation ──────────────────────────────────────────
  step('Channel messages in #engineering');

  console.log(`${DIM}${'─'.repeat(60)}${R}`);
  for (const msg of CHANNEL_MESSAGES) {
    const color = colors[msg.from] || CYAN;
    await run(`Send: ${msg.from} → #${channelName}`, async () => {
      log('📤', `${color}${B}${msg.from}${R}: ${msg.text}`);
      await agentMap[msg.from].send(channelName, msg.text);
    });
    await pause();
  }
  console.log(`${DIM}${'─'.repeat(60)}${R}`);

  // ── 7. Direct messages — Lead ↔ InfraAgent ─────────────────────────
  step('Direct messages');
  console.log(`${DIM}${'─'.repeat(60)}${R}`);

  await run(`${LEAD} DMs ${INFRA}`, async () => {
    log('📤', `${YELLOW}${B}${LEAD}${R} → ${GREEN}${B}${INFRA}${R}: Hey, is the deploy key rotated for staging?`);
    await lead.dm(INFRA, 'Hey, is the deploy key rotated for staging?');
  });
  await pause();

  await run(`${INFRA} DMs ${LEAD}`, async () => {
    log('📤', `${GREEN}${B}${INFRA}${R} → ${YELLOW}${B}${LEAD}${R}: Yes, rotated it last Tuesday. All environments are up to date.`);
    await infra.dm(LEAD, 'Yes, rotated it last Tuesday. All environments are up to date.');
  });
  await pause();

  await run(`${LEAD} DMs ${INFRA} (follow-up)`, async () => {
    log('📤', `${YELLOW}${B}${LEAD}${R} → ${GREEN}${B}${INFRA}${R}: Perfect. Can you share the new fingerprint with BackendAgent?`);
    await lead.dm(INFRA, 'Perfect. Can you share the new fingerprint with BackendAgent?');
  });
  await pause();

  await run(`${INFRA} DMs ${LEAD} (follow-up)`, async () => {
    log('📤', `${GREEN}${B}${INFRA}${R} → ${YELLOW}${B}${LEAD}${R}: Done — sent it over.`);
    await infra.dm(LEAD, 'Done — sent it over.');
  });
  await pause();

  // InfraAgent → BackendAgent side conversation
  await run(`${INFRA} DMs ${BACKEND}`, async () => {
    log('📤', `${GREEN}${B}${INFRA}${R} → ${BLUE}${B}${BACKEND}${R}: Here is the new staging deploy key fingerprint: SHA256:abc123...`);
    await infra.dm(BACKEND, 'Here is the new staging deploy key fingerprint: SHA256:abc123...');
  });
  await pause();

  await run(`${BACKEND} DMs ${INFRA}`, async () => {
    log('📤', `${BLUE}${B}${BACKEND}${R} → ${GREEN}${B}${INFRA}${R}: Got it, updated my local config. Thanks!`);
    await backend.dm(INFRA, 'Got it, updated my local config. Thanks!');
  });
  await pause();
  console.log(`${DIM}${'─'.repeat(60)}${R}`);

  // ── 8. Reactions ─────────────────────────────────────────────────────
  step('Reactions');
  await run('Add reactions', async () => {
    const msgs = await lead.messages(channelName, { limit: 1 });
    if (msgs.length === 0) throw new Error('No messages found');
    const lastId = msgs[0].id;

    await lead.react(lastId, '🚀');
    log('😀', `${YELLOW}${B}${LEAD}${R} reacted 🚀`);
    await pause();

    await infra.react(lastId, '👍');
    log('😀', `${GREEN}${B}${INFRA}${R} reacted 👍`);
    await pause();

    await backend.react(lastId, '✅');
    log('😀', `${BLUE}${B}${BACKEND}${R} reacted ✅`);

    const reactions = await lead.reactions(lastId);
    log('📊', `Reactions on message: ${JSON.stringify(reactions)}`);
  });
  await pause();

  // ── 9. Thread replies ────────────────────────────────────────────────
  step('Threads');
  await run('Thread replies', async () => {
    const msgs = await lead.messages(channelName, { limit: 1 });
    if (msgs.length === 0) throw new Error('No messages found');
    const parentId = msgs[0].id;

    await infra.reply(parentId, 'Deploy logs look clean. No rollback needed.');
    log('🧵', `${GREEN}${B}${INFRA}${R} replied in thread`);
    await pause();

    await backend.reply(parentId, 'Confirmed — no regressions in the test suite.');
    log('🧵', `${BLUE}${B}${BACKEND}${R} replied in thread`);
    await pause();

    await lead.reply(parentId, 'Excellent. Closing this out.');
    log('🧵', `${YELLOW}${B}${LEAD}${R} replied in thread`);

    const thread = await lead.thread(parentId);
    log('📊', `Thread has ${Array.isArray(thread) ? thread.length : 'unknown'} messages`);
  });
  await pause();

  // ── 10. Channel topic update ──────────────────────────────────────────
  step('Channel topic');
  await run('Update topic', async () => {
    await lead.channels.setTopic(channelName, 'Pipeline fix deployed — all green ✓');
    log('📝', `Topic updated on #${channelName}`);
  });
  await pause();

  // ── 11. Read receipts ────────────────────────────────────────────────
  step('Read receipts');
  await run('Mark read + check', async () => {
    const msgs = await backend.messages(channelName, { limit: 1 });
    if (msgs.length === 0) throw new Error('No messages found');
    await backend.markRead(msgs[0].id);
    log('👁️ ', `${BLUE}${B}${BACKEND}${R} marked latest message as read`);
  });
  await pause();

  // ── 12. Search ───────────────────────────────────────────────────────
  step('Search');
  await run('Full-text search', async () => {
    const results = await lead.search('health check');
    log('🔍', `Search "health check" → ${Array.isArray(results) ? results.length : 0} result(s)`);
  });
  await pause();

  // ── 13. List channels / agents ───────────────────────────────────────
  step('List resources');
  await run('List channels', async () => {
    const channels = await lead.channels.list();
    log('📋', `Channels: ${channels.map((c) => `#${c.name}`).join(', ')}`);
  });

  await run('List agents', async () => {
    const agentList = await relay.agents.list();
    log('📋', `Agents: ${agentList.map((a) => a.name).join(', ')}`);
  });

  await run('Agent presence', async () => {
    const presence = await relay.agents.presence();
    log('📋', `Presence: ${presence.map((p) => `${p.agentName}=${p.status}`).join(', ')}`);
  });
  await pause();

  // ── 14. Inbox ────────────────────────────────────────────────────────
  step('Inbox');
  await run('Check inbox', async () => {
    const inbox = await lead.inbox();
    log('📬', `${LEAD} inbox: ${JSON.stringify(inbox).slice(0, 120)}…`);
  });

  // Let trailing WS events flush
  await pause();

  // ── 15. Commands ──────────────────────────────────────────────────────
  step('Commands');

  await run('Register /deploy command', async () => {
    await relay.commands.register({
      command: 'deploy',
      description: 'Deploy the application to staging or production',
      handlerAgent: LEAD,
      parameters: [
        { name: 'env', type: 'string' as const, required: true, description: 'Target environment' },
      ],
    });
    log('⚙️ ', `Registered ${B}/deploy${R} command handled by ${YELLOW}${B}${LEAD}${R}`);
  });
  await pause();

  await run('List commands', async () => {
    const cmds = await relay.commands.list();
    if (cmds.length === 0) throw new Error('Expected at least one command');
    log('📋', `Commands: ${cmds.map((c) => `/${c.command}`).join(', ')}`);
  });

  await run(`${BACKEND} invokes /deploy`, async () => {
    const result = await backend.commands.invoke('deploy', {
      channel: channelName,
      args: '--env staging',
    });
    log('🚀', `${BLUE}${B}${BACKEND}${R} invoked /deploy → invocation ${JSON.stringify(result).slice(0, 80)}`);
  });
  await pause();

  await run('Delete /deploy command', async () => {
    await relay.commands.delete('deploy');
    log('🗑️ ', `Deleted /deploy command`);
  });
  await pause();

  // ── 16. Inbound Webhooks ──────────────────────────────────────────────
  step('Inbound Webhooks');

  let webhookId = '';
  await run('Create inbound webhook', async () => {
    const wh = await relay.webhooks.create({
      name: 'CI Pipeline',
      channel: channelName,
    });
    webhookId = wh.webhookId;
    log('🔗', `Created webhook ${B}${wh.webhookId}${R} → #${channelName}`);
  });
  await pause();

  await run('List webhooks', async () => {
    const whs = await relay.webhooks.list();
    if (whs.length === 0) throw new Error('Expected at least one webhook');
    log('📋', `Webhooks: ${whs.map((w) => w.name).join(', ')}`);
  });

  await run('Trigger webhook', async () => {
    await relay.webhooks.trigger(webhookId, {
      text: 'Build #142 passed — all tests green',
      source: 'github-actions',
    });
    log('📥', `Triggered webhook with CI notification`);
  });
  await pause();

  await run('Delete webhook', async () => {
    await relay.webhooks.delete(webhookId);
    log('🗑️ ', `Deleted webhook ${webhookId}`);
  });
  await pause();

  // ── 17. Event Subscriptions ───────────────────────────────────────────
  step('Event Subscriptions');

  let subId = '';
  await run('Create subscription', async () => {
    const sub = await relay.subscriptions.create({
      events: ['message.created', 'reaction.added'],
      url: 'https://httpbin.org/post',
    });
    subId = sub.id;
    log('📡', `Created subscription ${B}${sub.id}${R} for message.created, reaction.added`);
  });
  await pause();

  await run('List subscriptions', async () => {
    const subs = await relay.subscriptions.list();
    if (subs.length === 0) throw new Error('Expected at least one subscription');
    log('📋', `Subscriptions: ${subs.length}`);
  });

  await run('Get subscription by ID', async () => {
    const sub = await relay.subscriptions.get(subId);
    if (sub.id !== subId) throw new Error(`Expected sub ID ${subId}, got ${sub.id}`);
    log('📋', `Subscription ${B}${sub.id}${R}: events=${JSON.stringify(sub.events)}`);
  });

  await run('Delete subscription', async () => {
    await relay.subscriptions.delete(subId);
    log('🗑️ ', `Deleted subscription ${subId}`);
  });
  await pause();

  // ── 18. Group DMs ─────────────────────────────────────────────────────
  step('Group DMs');
  console.log(`${DIM}${'─'.repeat(60)}${R}`);

  await run(`${LEAD} creates group DM`, async () => {
    log('📤', `${YELLOW}${B}${LEAD}${R} → group(${INFRA}, ${BACKEND}): Let's sync on the deploy pipeline offline.`);
    await lead.dms.createGroup({
      participants: [INFRA, BACKEND],
      text: 'Let\'s sync on the deploy pipeline offline.',
      name: 'Deploy Sync',
    });
  });
  await pause();

  // Retrieve the group conversation and send follow-up messages
  await run(`${INFRA} replies in group DM`, async () => {
    const convos = await infra.dms.conversations();
    const group = convos.find((c) => c.type === 'group');
    if (!group) throw new Error('Group DM conversation not found');
    await infra.dms.sendMessage(group.id, 'Sounds good. I have the runbook ready.');
    log('📤', `${GREEN}${B}${INFRA}${R} → group: Sounds good. I have the runbook ready.`);
  });
  await pause();

  await run(`${BACKEND} replies in group DM`, async () => {
    const convos = await backend.dms.conversations();
    const group = convos.find((c) => c.type === 'group');
    if (!group) throw new Error('Group DM conversation not found');
    await backend.dms.sendMessage(group.id, 'I can run the integration tests after. Ready when you are.');
    log('📤', `${BLUE}${B}${BACKEND}${R} → group: I can run the integration tests after. Ready when you are.`);
  });
  await pause();
  console.log(`${DIM}${'─'.repeat(60)}${R}`);

  // ── 19. Channel archive ───────────────────────────────────────────────
  step('Channel archive');

  await run(`Archive #${channelName}`, async () => {
    await lead.channels.archive(channelName);
    log('📦', `${YELLOW}${B}${LEAD}${R} archived #${channelName}`);
  });

  await run('Archived channel not in active list', async () => {
    const channels = await lead.channels.list();
    const found = channels.find((c) => c.name === channelName);
    if (found) throw new Error(`Expected #${channelName} to be absent from active list`);
    log('📋', `#${channelName} is not in active channel list (correct)`);
  });

  await run('Archived channel visible with includeArchived', async () => {
    const channels = await lead.channels.list({ includeArchived: true });
    const found = channels.find((c) => c.name === channelName);
    if (!found) throw new Error(`Expected #${channelName} in archived list`);
    log('📋', `#${channelName} found with includeArchived=true`);
  });
  await pause();

  // ── 19a. Presence lifecycle ──────────────────────────────────────────
  step('Presence lifecycle');

  await run('Heartbeat keeps agent online', async () => {
    await lead.presence.heartbeat();
    const presence = await relay.agents.presence();
    const leadPresence = presence.find((p) => p.agentName === LEAD);
    if (!leadPresence) throw new Error(`${LEAD} not found in presence list`);
    if (leadPresence.status !== 'online') throw new Error(`Expected ${LEAD} online after heartbeat, got ${leadPresence.status}`);
    log('💓', `${YELLOW}${B}${LEAD}${R} heartbeat sent — status: online`);
  });

  await run('markOffline transitions agent to offline', async () => {
    await infra.presence.markOffline();
    // Poll for offline status
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(500);
      const presence = await relay.agents.presence();
      const infraPresence = presence.find((p) => p.agentName === INFRA);
      if (infraPresence?.status === 'offline') {
        log('💤', `${GREEN}${B}${INFRA}${R} marked offline — status: offline`);
        return;
      }
    }
    throw new Error(`${INFRA} did not transition to offline after markOffline`);
  });

  await run('markOnline brings agent back online', async () => {
    await infra.presence.markOnline();
    // Poll for online status
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(500);
      const presence = await relay.agents.presence();
      const infraPresence = presence.find((p) => p.agentName === INFRA);
      if (infraPresence?.status === 'online') {
        log('🟢', `${GREEN}${B}${INFRA}${R} marked online — status: online`);
        return;
      }
    }
    throw new Error(`${INFRA} did not transition to online after markOnline`);
  });
  await pause();

  // ── 19b. Idempotency ───────────────────────────────────────────────
  step('Idempotency');

  await run('Duplicate send with same idempotency key returns same message', async () => {
    // Unarchive channel so we can post to it, or use #general
    const testChannel = 'general';
    const idempotencyKey = `e2e-idem-${Date.now()}`;
    const msg1 = await lead.send(testChannel, 'Idempotency test message', { idempotencyKey });
    // Allow KV eventual consistency to propagate the idempotency record
    await sleep(1500);
    const msg2 = await lead.send(testChannel, 'Idempotency test message', { idempotencyKey });
    if (msg1.id !== msg2.id) throw new Error(`Expected same message ID, got ${msg1.id} and ${msg2.id}`);
    log('🔁', `Same idempotency key → same message ID: ${B}${msg1.id}${R}`);
  });

  await run('Different idempotency keys create different messages', async () => {
    const testChannel = 'general';
    const key1 = `e2e-idem-a-${Date.now()}`;
    const key2 = `e2e-idem-b-${Date.now()}`;
    const msg1 = await lead.send(testChannel, 'Idempotency distinct test', { idempotencyKey: key1 });
    const msg2 = await lead.send(testChannel, 'Idempotency distinct test', { idempotencyKey: key2 });
    if (msg1.id === msg2.id) throw new Error(`Expected different message IDs, got same: ${msg1.id}`);
    log('🔁', `Different keys → different messages: ${B}${msg1.id}${R} vs ${B}${msg2.id}${R}`);
  });
  await pause();

  // ── 19c. Error handling ────────────────────────────────────────────
  step('Error handling');

  await run('Invalid workspace key throws unauthorized', async () => {
    const badRelay = new RelayCast({ apiKey: 'rk_live_bogus_key_12345', baseUrl: BASE_URL });
    try {
      await badRelay.agents.list();
      throw new Error('Expected RelayError but call succeeded');
    } catch (err) {
      if (!(err instanceof RelayError)) throw new Error(`Expected RelayError, got ${(err as Error).constructor.name}`);
      if (err.code !== 'unauthorized') throw new Error(`Expected code 'unauthorized', got '${err.code}'`);
      log('🔒', `Invalid API key correctly threw RelayError(code=${err.code})`);
    }
  });

  await run('Non-existent channel throws not_found', async () => {
    try {
      await lead.messages('nonexistent-channel-xyz-' + Date.now());
      throw new Error('Expected RelayError but call succeeded');
    } catch (err) {
      if (!(err instanceof RelayError)) throw new Error(`Expected RelayError, got ${(err as Error).constructor.name}`);
      if (err.code !== 'not_found') throw new Error(`Expected code 'not_found', got '${err.code}'`);
      log('🔒', `Non-existent channel correctly threw RelayError(code=${err.code})`);
    }
  });
  await pause();

  // ── 20. Disconnect + verify presence ──────────────────────────────────
  step('Disconnect agents & verify status');
  await Promise.all([lead.disconnect(), infra.disconnect(), backend.disconnect()]);
  log('🔌', `All agents disconnected`);

  await run('Agents show offline after disconnect', async () => {
    // Poll presence — the DO hibernation close callback is async
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(1000);
      const presence = await relay.agents.presence();
      const statuses = Object.fromEntries(presence.map((p) => [p.agentName, p.status]));
      const allOffline = [LEAD, INFRA, BACKEND].every((name) => statuses[name] === 'offline');
      log('📋', `Presence: ${presence.map((p) => `${p.agentName}=${p.status}`).join(', ')}`);
      if (allOffline) return;
      if (attempt === 9) {
        throw new Error(`Expected all agents offline, got: ${JSON.stringify(statuses)}`);
      }
    }
  });

  // ── Summary ──────────────────────────────────────────────────────────
  console.log(`
${B}${CYAN}╔══════════════════════════════════════════════╗
║                   Results                    ║
╚══════════════════════════════════════════════╝${R}
`);
  for (const name of passed) console.log(`  ${GREEN}✓${R} ${name}`);
  for (const name of failed) console.log(`  ${RED}✗${R} ${name}`);
  console.log(`
  ${B}${passed.length}${R} passed, ${failed.length > 0 ? `${RED}${B}${failed.length}${R}` : '0'} failed
  ${B}${wsEvents}${R} WebSocket events received
`);

  await sleep(300);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n${RED}${B}Fatal:${R}`, err.message ?? err);
  process.exit(1);
});
