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
import { RelayCast, AgentClient, HttpClient } from '../packages/sdk/src/index.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const BASE_URL = args[0] ?? 'http://localhost:8787';
const CI = flags.has('--ci') || !!process.env.CI;
const DELAY_MS = CI ? 300 : 1200;

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
// Deterministic conversation
// ---------------------------------------------------------------------------
const CHANNEL_MESSAGES: Array<{ from: 'alice' | 'bob'; text: string }> = [
  { from: 'alice', text: 'Hey Bob, are you online?' },
  { from: 'bob', text: 'Yes! Just connected. What are we working on today?' },
  { from: 'alice', text: 'We need to review the deployment pipeline.' },
  { from: 'bob', text: 'Good idea. I noticed the staging build was flaky yesterday.' },
  { from: 'alice', text: 'Found it — the timeout was too short on the health check.' },
  { from: 'bob', text: 'Nice catch. Should we bump it to 30s?' },
  { from: 'alice', text: 'Yeah, 30s with a retry. Pushing the fix now.' },
  { from: 'bob', text: 'Perfect. I will review it once it is up.' },
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
  let alice!: AgentClient;
  let bob!: AgentClient;
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

  // ── 1. Create workspace ──────────────────────────────────────────────
  step('Create workspace');
  await run('Create workspace', async () => {
    const wsName = `e2e-${Date.now()}`;
    const res = await RelayCast.createWorkspace(wsName, BASE_URL);
    workspaceKey = res.api_key;
    relay = new RelayCast({ apiKey: workspaceKey, baseUrl: BASE_URL });
    log('🔑', `Workspace ${B}${wsName}${R} — key: ${DIM}${workspaceKey.slice(0, 16)}…${R}`);
  });

  if (!CI) {
    console.log();
    log('📊', `Open the dashboard: ${B}${CYAN}http://localhost:3100${R}`);
    log('🔑', `Workspace key: ${B}${workspaceKey}${R}`);
    console.log();
    await waitForEnter(`${YELLOW}${B}  Press Enter to start the test run...${R} `);
  } else {
    await sleep(DELAY_MS);
  }

  // ── 2. Register agents ───────────────────────────────────────────────
  step('Register agents');
  let aliceToken = '';
  let bobToken = '';

  await run('Register alice', async () => {
    const res = await relay.agents.register({
      name: 'alice',
      type: 'agent',
      persona: 'Senior engineer — infrastructure',
    });
    aliceToken = res.token;
    alice = relay.as(aliceToken);
    log('🤖', `${GREEN}${B}alice${R} registered`);
  });

  await run('Register bob', async () => {
    const res = await relay.agents.register({
      name: 'bob',
      type: 'agent',
      persona: 'Backend dev — testing & reliability',
    });
    bobToken = res.token;
    bob = relay.as(bobToken);
    log('🤖', `${BLUE}${B}bob${R} registered`);
  });

  await sleep(DELAY_MS);

  // ── 3. Create channel + join ─────────────────────────────────────────
  step('Create channel');
  await run('Create #engineering', async () => {
    await alice.channels.create({ name: channelName, topic: 'Deployment pipeline review' });
    log('📢', `Channel ${B}#${channelName}${R} created by alice`);
  });

  await run('Bob joins #engineering', async () => {
    await bob.channels.join(channelName);
    log('👋', `${BLUE}${B}bob${R} joined #${channelName}`);
  });

  await sleep(DELAY_MS);

  // ── 4. Connect WebSockets ────────────────────────────────────────────
  step('Connect WebSockets');

  // Track WS events for summary
  let wsEvents = 0;

  await run('WebSocket connect + subscribe', async () => {
    alice.connect();
    bob.connect();

    // Wait for both connections
    await Promise.all([
      new Promise<void>((res) => { alice.on.connected(res); }),
      new Promise<void>((res) => { bob.on.connected(res); }),
    ]);

    // Listen for events
    alice.on.messageCreated((e) => { wsEvents++; ws('alice', 'message.created', `from ${B}${e.message.agent_name}${R}: "${e.message.text}"`); });
    bob.on.messageCreated((e) => { wsEvents++; ws('bob', 'message.created', `from ${B}${e.message.agent_name}${R}: "${e.message.text}"`); });
    alice.on.dmReceived((e) => { wsEvents++; ws('alice', 'dm.received', `from ${B}${e.message.from_name}${R}: "${e.message.text}"`); });
    bob.on.dmReceived((e) => { wsEvents++; ws('bob', 'dm.received', `from ${B}${e.message.from_name}${R}: "${e.message.text}"`); });
    alice.on.reactionAdded((e) => { wsEvents++; ws('alice', 'reaction.added', `${e.emoji}`); });
    bob.on.reactionAdded((e) => { wsEvents++; ws('bob', 'reaction.added', `${e.emoji}`); });
    alice.on.channelUpdated(() => { wsEvents++; ws('alice', 'channel.updated', ''); });
    bob.on.channelUpdated(() => { wsEvents++; ws('bob', 'channel.updated', ''); });

    alice.subscribe([channelName]);
    bob.subscribe([channelName]);

    log('🔌', `Both agents connected & subscribed to #${channelName}`);
  });

  await sleep(DELAY_MS);

  // ── 5. Channel conversation ──────────────────────────────────────────
  step('Channel messages');
  const agents = { alice, bob };
  const colors: Record<string, string> = { alice: GREEN, bob: BLUE };

  console.log(`${DIM}${'─'.repeat(60)}${R}`);
  for (const msg of CHANNEL_MESSAGES) {
    await run(`Send: ${msg.from} → #${channelName}`, async () => {
      log('📤', `${colors[msg.from]}${B}${msg.from}${R}: ${msg.text}`);
      await agents[msg.from].send(channelName, msg.text);
    });
    await sleep(DELAY_MS);
  }
  console.log(`${DIM}${'─'.repeat(60)}${R}`);

  // ── 6. Direct messages ───────────────────────────────────────────────
  step('Direct messages');
  await run('Alice DMs bob', async () => {
    log('📤', `${GREEN}${B}alice${R} → ${BLUE}${B}bob${R}: Quick question about the deploy key`);
    await alice.dm('bob', 'Quick question about the deploy key — is it rotated?');
  });
  await sleep(DELAY_MS);

  await run('Bob DMs alice', async () => {
    log('📤', `${BLUE}${B}bob${R} → ${GREEN}${B}alice${R}: Yes, rotated it last week`);
    await bob.dm('alice', 'Yes, I rotated it last week. All good.');
  });
  await sleep(DELAY_MS);

  // ── 7. Reactions ─────────────────────────────────────────────────────
  step('Reactions');
  await run('Add reactions', async () => {
    const msgs = await alice.messages(channelName, { limit: 1 });
    if (msgs.length === 0) throw new Error('No messages found');
    const lastId = msgs[0].id;

    await alice.react(lastId, '🚀');
    log('😀', `${GREEN}${B}alice${R} reacted 🚀`);
    await sleep(500);

    await bob.react(lastId, '👍');
    log('😀', `${BLUE}${B}bob${R} reacted 👍`);

    const reactions = await alice.reactions(lastId);
    log('📊', `Reactions on message: ${JSON.stringify(reactions)}`);
  });
  await sleep(DELAY_MS);

  // ── 8. Thread replies ────────────────────────────────────────────────
  step('Threads');
  await run('Thread replies', async () => {
    const msgs = await alice.messages(channelName, { limit: 1 });
    if (msgs.length === 0) throw new Error('No messages found');
    const parentId = msgs[0].id;

    await alice.reply(parentId, 'Let me add that to the PR description.');
    log('🧵', `${GREEN}${B}alice${R} replied in thread`);
    await sleep(DELAY_MS);

    await bob.reply(parentId, 'LGTM once that is updated.');
    log('🧵', `${BLUE}${B}bob${R} replied in thread`);

    const thread = await alice.thread(parentId);
    log('📊', `Thread has ${Array.isArray(thread) ? thread.length : 'unknown'} messages`);
  });
  await sleep(DELAY_MS);

  // ── 9. Channel topic update ──────────────────────────────────────────
  step('Channel topic');
  await run('Update topic', async () => {
    await alice.channels.setTopic(channelName, 'Pipeline review — fix deployed ✓');
    log('📝', `Topic updated on #${channelName}`);
  });
  await sleep(DELAY_MS);

  // ── 10. Read receipts ────────────────────────────────────────────────
  step('Read receipts');
  await run('Mark read + check', async () => {
    const msgs = await bob.messages(channelName, { limit: 1 });
    if (msgs.length === 0) throw new Error('No messages found');
    await bob.markRead(msgs[0].id);
    log('👁️ ', `${BLUE}${B}bob${R} marked latest message as read`);
  });
  await sleep(DELAY_MS);

  // ── 11. Search ───────────────────────────────────────────────────────
  step('Search');
  await run('Full-text search', async () => {
    const results = await alice.search('health check');
    log('🔍', `Search "health check" → ${Array.isArray(results) ? results.length : 0} result(s)`);
  });
  await sleep(DELAY_MS);

  // ── 12. List channels / agents ───────────────────────────────────────
  step('List resources');
  await run('List channels', async () => {
    const channels = await alice.channels.list();
    log('📋', `Channels: ${channels.map((c) => `#${c.name}`).join(', ')}`);
  });

  await run('List agents', async () => {
    const agents = await relay.agents.list();
    log('📋', `Agents: ${agents.map((a) => a.name).join(', ')}`);
  });

  await run('Agent presence', async () => {
    const presence = await relay.agents.presence();
    log('📋', `Presence: ${presence.map((p) => `${p.name}=${p.status}`).join(', ')}`);
  });
  await sleep(DELAY_MS);

  // ── 13. Inbox ────────────────────────────────────────────────────────
  step('Inbox');
  await run('Check inbox', async () => {
    const inbox = await alice.inbox();
    log('📬', `Alice inbox: ${JSON.stringify(inbox).slice(0, 120)}…`);
  });

  // Let trailing WS events flush
  await sleep(1500);

  // ── Cleanup ──────────────────────────────────────────────────────────
  alice.disconnect();
  bob.disconnect();

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
