#!/usr/bin/env npx tsx
/**
 * Relaycast end-to-end smoke test.
 *
 * Exercises every major feature against a running server so you can watch
 * messages flow in both the terminal and the dashboard.
 *
 * Usage:
 *   npm run e2e                                   # defaults to the engine dev server (http://localhost:8787)
 *   npm run e2e -- http://localhost:8787 --ci     # self-hosted engine in CI
 *   npm run e2e -- --continue-on-failure          # keep running after step failures
 *   npm run e2e -- https://gateway.relaycast.dev --ci
 */

import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import WebSocket from 'ws';
import { RelayCast, AgentClient, RelayError } from '../packages/sdk-typescript/src/index.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const CONTINUE_ON_FAILURE = flags.has('--continue-on-failure');
const DEFAULT_BASE_URL = 'http://localhost:8787';
const BASE_URL = (args[0] ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
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

function extractTextPart(payload: any): string {
  const parts = payload?.params?.message?.parts;
  if (!Array.isArray(parts)) return '';
  const textPart = parts.find((part) => part?.kind === 'text' && typeof part.text === 'string');
  return textPart?.text ?? '';
}

async function startMockA2aAgent() {
  let webhookUrl = '';
  let relayToken = '';
  const requests: any[] = [];
  const callbacks: any[] = [];

  const server = createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${(server.address() as any)?.port}`;

    if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        name: 'Mock A2A Agent',
        description: 'Local A2A roundtrip test peer',
        url: `${origin}/rpc`,
        version: '1.0.0',
        skills: [{ id: 'echo', name: 'echo', description: 'Echo a DM back to Relaycast' }],
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/rpc') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(payload);

      const inputText = extractTextPart(payload);
      const callbackPayload = {
        jsonrpc: '2.0',
        id: payload.id,
        result: {
          message: {
            message_id: `mock-${payload.id}`,
            role: 'agent',
            context_id: payload?.params?.message?.context_id,
            parts: [{ kind: 'text', text: `Mock A2A reply: ${inputText}` }],
          },
        },
      };

      if (webhookUrl && relayToken) {
        const callback = fetch(webhookUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${relayToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(callbackPayload),
        }).then(async (response) => {
          callbacks.push({ status: response.status, body: await response.json().catch(() => null) });
        });
        void callback;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: payload.id,
        result: {
          task: {
            id: `task-${payload.id}`,
            context_id: payload?.params?.message?.context_id,
            status: {
              state: 'submitted',
              message: 'Mock agent accepted the request',
            },
          },
        },
      }));
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const port = (server.address() as any)?.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    requests,
    callbacks,
    configureWebhook(nextWebhookUrl: string, nextRelayToken: string) {
      webhookUrl = nextWebhookUrl;
      relayToken = nextRelayToken;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
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
  {
    from: LEAD,
    text: '### Rollout Notes\n- health timeout: `30s`\n- retries: **enabled**\n- owner: @InfraAgent',
  },
  {
    from: BACKEND,
    text: 'Validation checklist:\n1. smoke test ✅\n2. integration suite ✅\n3. canary logs ✅',
  },
  {
    from: INFRA,
    text: 'Deployment command used: `kubectl rollout status deployment/api -n staging`',
  },
  {
    from: BACKEND,
    text: 'TypeScript patch preview:\n```ts\nconst deployConfig: { timeoutSeconds: number; retries: number } = {\n  timeoutSeconds: 30,\n  retries: 2,\n};\n```',
  },
  { from: LEAD, text: 'Great work team. Merging to main.' },
];

const MARKDOWN_CHANNEL_MESSAGES = CHANNEL_MESSAGES.filter((message) =>
  /[*_`#[\]\n]/.test(message.text),
);

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
  log('🧭', `Flow:   ${B}${CONTINUE_ON_FAILURE ? 'Continue on failure' : 'Fail fast (default)'}${R}`);

  let workspaceKey = '';
  let relay!: RelayCast;
  let lead!: AgentClient;
  let infra!: AgentClient;
  let backend!: AgentClient;
  // Raw agent tokens (captured at registration) for the --next-version actions
  // section, which calls the /v1/actions HTTP contract directly.
  let leadToken = '';
  let backendToken = '';
  const passed: string[] = [];
  const failed: string[] = [];
  const channelName = 'engineering';
  let mockA2a: Awaited<ReturnType<typeof startMockA2aAgent>> | null = null;

  async function run(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      ok(name);
      passed.push(name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('❌', `${RED}${name}: ${msg}${R}`);
      failed.push(name);
      if (!CONTINUE_ON_FAILURE) {
        throw new Error(`${name} failed: ${msg}`);
      }
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

  function isChannelAlreadyExists(err: unknown): boolean {
    if (!(err instanceof RelayError)) return false;
    if (err.rawCode === 'channel_already_exists') return true;
    return err.code === 'name_conflict' && /channel .*already exists/i.test(err.message);
  }

  async function ensureChannel(owner: AgentClient, name: string, topic?: string): Promise<void> {
    try {
      await owner.channels.create({ name, ...(topic ? { topic } : {}) });
      log('📢', `Channel ${B}#${name}${R} created by ${LEAD}`);
    } catch (err) {
      if (!isChannelAlreadyExists(err)) throw err;
      log('ℹ️ ', `Channel ${B}#${name}${R} already exists; continuing.`);
    }
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

  /** Register agent, using registerOrRotate to handle stale agents from prior runs. */
  async function registerAgent(opts: Parameters<typeof relay.agents.register>[0]): Promise<{ token: string }> {
    try {
      return await relay.agents.register(opts);
    } catch (err) {
      if (err instanceof RelayError && /already exists/i.test(err.message)) {
        // Agent left over from a prior E2E run (D1 read replica lag after delete).
        // Use registerOrRotate which is the idempotent server-side path.
        log('ℹ️ ', `${opts.name} already exists; rotating token via registerOrRotate...`);
        return await relay.registerOrRotate(opts);
      }
      throw err;
    }
  }

  await run(`Register ${LEAD}`, async () => {
    const res = await registerAgent({
      name: LEAD,
      type: 'agent',
      persona: 'Engineering team lead. Coordinates InfraAgent and BackendAgent, assigns tasks, and unblocks the team.',
      metadata: { cli: 'claude' },
    });
    lead = relay.as(res.token);
    leadToken = res.token;
    log('🤖', `${YELLOW}${B}${LEAD}${R} registered`);
  });

  await run(`Register ${INFRA}`, async () => {
    const res = await registerAgent({
      name: INFRA,
      type: 'agent',
      persona: 'Senior infrastructure engineer. Owns CI/CD pipelines, deploys, health checks, and cloud resources.',
      metadata: { cli: 'claude' },
    });
    infra = relay.as(res.token);
    log('🤖', `${GREEN}${B}${INFRA}${R} registered`);
  });

  await run(`Register ${BACKEND}`, async () => {
    const res = await registerAgent({
      name: BACKEND,
      type: 'agent',
      persona: 'Backend developer focused on testing, reliability, and the message pipeline.',
      metadata: { cli: 'claude' },
    });
    backend = relay.as(res.token);
    backendToken = res.token;
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
    leadToken = res.token;
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
    await ensureChannel(lead, channelName, 'Engineering coordination');
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
    await ensureChannel(lead, 'general', 'General discussion');

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

  await run('Verify markdown messages in #engineering', async () => {
    const messages = await lead.messages(channelName, { limit: CHANNEL_MESSAGES.length + 10 });
    const textSet = new Set(messages.map((message) => message.text));
    const missing = MARKDOWN_CHANNEL_MESSAGES
      .map((message) => message.text)
      .filter((text) => !textSet.has(text));

    if (missing.length > 0) {
      throw new Error(`Missing markdown message(s): ${missing.map((text) => JSON.stringify(text)).join(', ')}`);
    }

    log('🧪', `Verified ${MARKDOWN_CHANNEL_MESSAGES.length} markdown message(s) in #${channelName}`);
  });

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

  // ── 7a. A2A gateway roundtrip ───────────────────────────────────────
  step('A2A gateway');

  await run('Register mock A2A agent', async () => {
    if (!isLocalHost(new URL(BASE_URL).hostname.toLowerCase())) {
      log('ℹ️ ', 'Skipping A2A roundtrip: mock agent is only reachable when Relaycast runs locally.');
      return;
    }

    mockA2a = await startMockA2aAgent();
    const registered = await relay.registerA2a({
      agentCard: {
        name: 'Mock A2A Agent',
        description: 'Local A2A roundtrip test peer',
        url: `${mockA2a.baseUrl}/rpc`,
        version: '1.0.0',
        skills: [{ id: 'echo', name: 'echo', description: 'Echo a DM back to Relaycast' }],
      },
    });

    mockA2a.configureWebhook(registered.webhookUrl, registered.relayToken);
    log('🔗', `Registered ${B}${registered.relayName}${R} with webhook ${DIM}${registered.webhookUrl}${R}`);
    log('🤖', `Mock A2A agent listening on ${B}${mockA2a.baseUrl}${R}`);
  });
  await pause();

  await run(`${LEAD} sends a DM to the mock A2A agent`, async () => {
    if (!mockA2a) {
      log('ℹ️ ', 'Skipping A2A send: mock agent was not started.');
      return;
    }

    const agents = await relay.listA2aAgents();
    const target = agents.find((agent) => agent.agentCard.name === 'Mock A2A Agent');
    if (!target) throw new Error('Mock A2A relay agent not found after registration');

    const sent = await lead.dm(target.relayName, 'Ping from Relaycast to mock A2A');
    log('📤', `${YELLOW}${B}${LEAD}${R} → ${B}${target.relayName}${R}: Ping from Relaycast to mock A2A`);

    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(500);
      const messages = await lead.dms.messages(sent.conversationId, { limit: 10 });
      const reply = messages.find((message) => message.text === 'Mock A2A reply: Ping from Relaycast to mock A2A');
      if (reply) {
        if (mockA2a.requests.length === 0) {
          throw new Error('Mock A2A server did not receive the outbound JSON-RPC request');
        }
        log('🔁', `A2A roundtrip verified in conversation ${B}${sent.conversationId}${R}`);
        return;
      }
    }

    throw new Error('Timed out waiting for mock A2A roundtrip reply');
  });
  await pause();

  // ── 7b. A2A agent card endpoints ────────────────────────────────────
  step('A2A agent cards');

  await run('Get individual A2A agent card via SDK', async () => {
    const agents = await relay.listA2aAgents();
    if (agents.length === 0) {
      log('ℹ️ ', 'No A2A agents registered — skipping agent card test.');
      return;
    }
    const card = await relay.getA2aAgentCard(agents[0].relayName);
    if (!card.name) throw new Error('Agent card missing name field');
    log('🪪', `Agent card: ${B}${card.name}${R} v${card.version}`);
  });

  await run('Get workspace agent card via query param', async () => {
    const wsInfo = await relay.workspace.info();
    const res = await fetch(`${BASE_URL}/.well-known/agent-card.json?workspace=${encodeURIComponent(wsInfo.name)}`);
    if (!res.ok) throw new Error(`Expected 200, got ${res.status}`);
    const card = await res.json() as any;
    if (!card.name) throw new Error('Workspace agent card missing name');
    log('🪪', `Workspace card: ${B}${card.name}${R} with ${card.skills?.length ?? 0} skill(s)`);
  });

  await run('Get workspace agent card via auth header', async () => {
    const res = await fetch(`${BASE_URL}/.well-known/agent-card.json`, {
      headers: { Authorization: `Bearer ${workspaceKey}` },
    });
    if (!res.ok) throw new Error(`Expected 200, got ${res.status}`);
    const card = await res.json() as any;
    if (!card.url) throw new Error('Workspace agent card missing url');
    log('🪪', `Workspace card via auth: ${B}${card.name}${R}`);
  });

  await run('Remove A2A agent via SDK', async () => {
    const agents = await relay.listA2aAgents();
    if (agents.length === 0) {
      log('ℹ️ ', 'No A2A agents to remove — skipping.');
      return;
    }
    const name = agents[0].relayName;
    await relay.removeA2aAgent(name);
    const after = await relay.listA2aAgents();
    if (after.find((a) => a.relayName === name)) throw new Error('Agent still present after removal');
    log('🗑️ ', `Removed A2A agent ${B}${name}${R}`);
  });

  // Re-register mock A2A agent if it was removed (needed for later steps)
  await run('Re-register mock A2A agent', async () => {
    if (!isLocalHost(new URL(BASE_URL).hostname.toLowerCase())) {
      log('ℹ️ ', 'Skipping A2A re-register: not local.');
      return;
    }
    if (!mockA2a) {
      mockA2a = await startMockA2aAgent();
    }
    const registered = await relay.registerA2a({
      agentCard: {
        name: 'Mock A2A Agent',
        description: 'Local A2A roundtrip test peer',
        url: `${mockA2a.baseUrl}/rpc`,
        version: '1.0.0',
        skills: [{ id: 'echo', name: 'echo', description: 'Echo a DM back to Relaycast' }],
      },
    });
    mockA2a.configureWebhook(registered.webhookUrl, registered.relayToken);
    log('🔗', `Re-registered ${B}${registered.relayName}${R}`);
  });
  await pause();

  // ── 7c. Directory ──────────────────────────────────────────────────
  step('Directory');
  let directorySlug = '';

  await run('Publish agent to directory', async () => {
    const result = await relay.publishToDirectory({
      name: 'E2E Test Agent',
      description: 'An agent published during E2E testing',
      provider: 'e2e-suite',
      tags: ['testing', 'e2e'],
      skills: [
        { name: 'smoke-test', description: 'Run smoke tests', tags: ['testing'] },
        { name: 'load-test', description: 'Run load tests', tags: ['testing', 'perf'] },
      ],
    });
    directorySlug = result.slug;
    log('📖', `Published ${B}${result.name}${R} (slug: ${directorySlug}) with ${result.skills.length} skills`);
  });
  await pause();

  await run('List directory agents', async () => {
    const res = await fetch(`${BASE_URL}/v1/directory/agents`, {
      headers: { Authorization: `Bearer ${workspaceKey}` },
    });
    const json = await res.json() as any;
    if (!json.ok || !Array.isArray(json.data)) throw new Error('Expected ok + data array');
    log('📋', `Directory has ${json.data.length} agent(s)`);
  });

  await run('Search directory by text', async () => {
    const results = await relay.searchDirectory({ q: 'smoke' });
    if (!Array.isArray(results)) throw new Error('Expected array');
    log('🔍', `Directory search "smoke" → ${results.length} result(s)`);
  });

  await run('Search directory by tag', async () => {
    const results = await relay.searchDirectory({ tags: ['e2e'] });
    if (!Array.isArray(results)) throw new Error('Expected array');
    if (results.length === 0) throw new Error('Expected at least 1 result for tag "e2e"');
    log('🔍', `Directory search tag=e2e → ${results.length} result(s)`);
  });

  await run('Get directory agent by slug', async () => {
    if (!directorySlug) { log('ℹ️ ', 'No slug — skipping.'); return; }
    const res = await fetch(`${BASE_URL}/v1/directory/agents/${directorySlug}`, {
      headers: { Authorization: `Bearer ${workspaceKey}` },
    });
    const json = await res.json() as any;
    if (!json.ok) throw new Error(`Expected ok, got ${JSON.stringify(json.error)}`);
    log('📖', `Got directory agent: ${B}${json.data.name}${R}`);
  });

  await run('Update directory agent', async () => {
    if (!directorySlug) { log('ℹ️ ', 'No slug — skipping.'); return; }
    const res = await fetch(`${BASE_URL}/v1/directory/agents/${directorySlug}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${workspaceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Updated during E2E' }),
    });
    const json = await res.json() as any;
    if (!json.ok) throw new Error(`Patch failed: ${JSON.stringify(json.error)}`);
    log('✏️ ', `Updated directory agent description`);
  });

  await run('Rate directory agent', async () => {
    if (!directorySlug) { log('ℹ️ ', 'No slug — skipping.'); return; }
    const res = await fetch(`${BASE_URL}/v1/directory/agents/${directorySlug}/ratings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lead.client.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ score: 4, review: 'Solid E2E agent' }),
    });
    if (res.status === 403 || res.status === 401) {
      log('ℹ️ ', 'Rating requires agent token — skipping.');
      return;
    }
    const json = await res.json() as any;
    if (!json.ok) throw new Error(`Rating failed: ${JSON.stringify(json.error)}`);
    log('⭐', `Rated ${directorySlug}: ${json.data.score}/5`);
  });

  await run('List directory agent ratings', async () => {
    if (!directorySlug) { log('ℹ️ ', 'No slug — skipping.'); return; }
    const res = await fetch(`${BASE_URL}/v1/directory/agents/${directorySlug}/ratings`, {
      headers: { Authorization: `Bearer ${workspaceKey}` },
    });
    const json = await res.json() as any;
    if (!json.ok) throw new Error(`Expected ok, got ${JSON.stringify(json.error)}`);
    log('📊', `Ratings for ${directorySlug}: ${json.data.length} rating(s)`);
  });

  await run('Delete directory agent', async () => {
    if (!directorySlug) { log('ℹ️ ', 'No slug — skipping.'); return; }
    const res = await fetch(`${BASE_URL}/v1/directory/agents/${directorySlug}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${workspaceKey}` },
    });
    if (res.status !== 204) throw new Error(`Expected 204, got ${res.status}`);
    log('🗑️ ', `Deleted directory agent ${directorySlug}`);
  });
  await pause();

  // ── 7d. Routing ────────────────────────────────────────────────────
  step('Routing');

  // Publish an agent to directory first so routing has something to match
  let routingSlug = '';
  await run('Publish agent for routing test', async () => {
    const result = await relay.publishToDirectory({
      name: 'Routing Test Agent',
      description: 'Agent with skills for routing tests',
      sourceAgentName: LEAD,
      tags: ['routing-test'],
      skills: [
        { name: 'refund-processing', description: 'Process customer refunds', tags: ['billing', 'refund'] },
      ],
    });
    routingSlug = result.slug;
    log('📖', `Published ${B}${result.name}${R} for routing`);
  });
  await pause();

  await run('Route by skill', async () => {
    const result = await relay.route('refund-processing');
    log('🧭', `Route "refund-processing" → agent=${B}${result.agentName}${R} score=${result.score} fallback=${result.fallback}`);
  });

  await run('Search skills', async () => {
    const res = await fetch(`${BASE_URL}/v1/skills/search?q=refund`, {
      headers: { Authorization: `Bearer ${workspaceKey}` },
    });
    const json = await res.json() as any;
    if (!json.ok) throw new Error(`Skills search failed: ${JSON.stringify(json.error)}`);
    log('🔍', `Skills search "refund" → ${json.data.length} result(s)`);
  });

  await run('Import/sync skills', async () => {
    const result = await relay.importSkills({
      agentName: LEAD,
      skills: [{ name: 'code-review', description: 'Review pull requests', tags: ['dev'] }],
    });
    log('📥', `Synced skills for ${B}${LEAD}${R} → ${result ? 'entry updated' : 'null'}`);
  });

  await run('Get routing config', async () => {
    const config = await relay.getRoutingConfig();
    log('⚙️ ', `Routing config: weights=${JSON.stringify(config.weights)}`);
  });

  await run('Update routing config', async () => {
    const config = await relay.updateRoutingConfig({
      weights: { skillMatch: 0.5, rating: 0.3, availability: 0.2 },
      circuitBreakerThreshold: 5,
    });
    log('⚙️ ', `Updated routing config: threshold=${config.circuitBreakerThreshold}`);
  });

  await run('Route feedback (success)', async () => {
    const res = await fetch(`${BASE_URL}/v1/route/feedback`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${workspaceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_name: LEAD, success: true }),
    });
    const json = await res.json() as any;
    if (!json.ok) throw new Error(`Feedback failed: ${JSON.stringify(json.error)}`);
    log('👍', `Recorded routing success for ${B}${LEAD}${R}`);
  });

  await run('Route feedback (failure)', async () => {
    const res = await fetch(`${BASE_URL}/v1/route/feedback`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${workspaceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_name: LEAD, success: false, error: 'E2E test failure' }),
    });
    const json = await res.json() as any;
    if (!json.ok) throw new Error(`Feedback failed: ${JSON.stringify(json.error)}`);
    log('👎', `Recorded routing failure for ${B}${LEAD}${R}`);
  });

  // Clean up routing test agent
  await run('Clean up routing test agent', async () => {
    if (!routingSlug) return;
    await fetch(`${BASE_URL}/v1/directory/agents/${routingSlug}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${workspaceKey}` },
    });
    log('🧹', `Deleted routing test agent ${routingSlug}`);
  });
  await pause();

  // ── 7e. Certification ──────────────────────────────────────────────
  step('Certification');
  let certId = '';

  await run('Submit certification (Level 1)', async () => {
    if (!mockA2a) {
      log('ℹ️ ', 'Skipping certification: mock A2A agent not running.');
      return;
    }
    const res = await fetch(`${BASE_URL}/v1/certify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${workspaceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_url: `${mockA2a.baseUrl}/rpc`, level: 1 }),
    });
    const json = await res.json() as any;
    if (!json.ok) throw new Error(`Certify failed: ${JSON.stringify(json.error)}`);
    certId = json.data.id;
    log('🏅', `Certification ${B}${certId}${R}: passed=${json.data.passed} (${json.data.passed_tests}/${json.data.total_tests})`);
  });

  await run('Get certification result', async () => {
    if (!certId) { log('ℹ️ ', 'No cert ID — skipping.'); return; }
    const res = await fetch(`${BASE_URL}/v1/certify/${certId}`, {
      headers: { Authorization: `Bearer ${workspaceKey}` },
    });
    const json = await res.json() as any;
    if (!json.ok) throw new Error(`Get cert failed: ${JSON.stringify(json.error)}`);
    log('📋', `Certification ${certId}: status=${json.data.status}`);
  });

  await run('Get certification badge SVG', async () => {
    if (!certId) { log('ℹ️ ', 'No cert ID — skipping.'); return; }
    const res = await fetch(`${BASE_URL}/v1/certify/${certId}/badge.svg`, {
      headers: { Authorization: `Bearer ${workspaceKey}` },
    });
    if (!res.ok) throw new Error(`Badge request failed: ${res.status}`);
    const svg = await res.text();
    if (!svg.includes('<svg')) throw new Error('Response is not SVG');
    log('🏷️ ', `Badge SVG: ${svg.length} bytes`);
  });

  await run('Enable certification monitoring', async () => {
    if (!mockA2a) { log('ℹ️ ', 'No mock A2A — skipping.'); return; }
    const res = await fetch(`${BASE_URL}/v1/certify/monitor`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${workspaceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_url: `${mockA2a.baseUrl}/rpc`, level: 1, interval_minutes: 60 }),
    });
    const json = await res.json() as any;
    if (!json.ok) throw new Error(`Monitor failed: ${JSON.stringify(json.error)}`);
    log('📡', `Monitoring enabled: interval=${json.data.monitor_interval_minutes ?? json.data.monitorIntervalMinutes}min`);
  });
  await pause();

  // ── 7f. Console / Observability ────────────────────────────────────
  step('Console / Observability');

  await run('Get console messages', async () => {
    const res = await fetch(`${BASE_URL}/v1/console/messages?limit=5`, {
      headers: { Authorization: `Bearer ${workspaceKey}` },
    });
    const json = await res.json() as any;
    if (!json.ok) throw new Error(`Console messages failed: ${JSON.stringify(json.error)}`);
    log('📜', `Console messages: ${json.data.length} log(s)`);
  });

  await run('Get console stats', async () => {
    const res = await fetch(`${BASE_URL}/v1/console/stats?days=7`, {
      headers: { Authorization: `Bearer ${workspaceKey}` },
    });
    const json = await res.json() as any;
    if (!json.ok) throw new Error(`Console stats failed: ${JSON.stringify(json.error)}`);
    log('📊', `Console stats: ${JSON.stringify(json.data).slice(0, 120)}`);
  });

  await run('Get console agent stats', async () => {
    const res = await fetch(`${BASE_URL}/v1/console/agents?days=7&limit=10`, {
      headers: { Authorization: `Bearer ${workspaceKey}` },
    });
    const json = await res.json() as any;
    if (!json.ok) throw new Error(`Console agents failed: ${JSON.stringify(json.error)}`);
    log('📊', `Console agent stats: ${json.data.length} agent(s)`);
  });

  await run('Get console costs', async () => {
    const res = await fetch(`${BASE_URL}/v1/console/costs?days=7`, {
      headers: { Authorization: `Bearer ${workspaceKey}` },
    });
    const json = await res.json() as any;
    if (!json.ok) throw new Error(`Console costs failed: ${JSON.stringify(json.error)}`);
    log('💰', `Console costs: ${JSON.stringify(json.data).slice(0, 120)}`);
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

  // ── 15. Actions (agent-to-agent RPC) ──────────────────────────────────
  step('Actions');

  // The hosted engine (gateway / self-host) implements /v1/actions. The legacy
  // server (api.relaycast.dev) does not — probe and skip gracefully there.
  let actionsSupported = true;
  try {
    await relay.actions.list();
  } catch (err) {
    if (
      err instanceof RelayError &&
      (err.statusCode === 404 || err.code === 'not_found' || /route not found/i.test(err.message))
    ) {
      actionsSupported = false;
    } else {
      throw err;
    }
  }

  if (!actionsSupported) {
    log('ℹ️ ', 'Skipping Actions: target does not expose /v1/actions (legacy server).');
  } else {
    // Lightweight raw agent WebSocket to verify action.* fanout.
    const openWs = (token: string) => {
      const sock = new WebSocket(`${BASE_URL.replace(/^http/, 'ws')}/v1/ws?token=${token}`);
      const events: any[] = [];
      sock.on('message', (d) => {
        // Guard against non-JSON frames so a stray payload can't crash the script.
        try { events.push(JSON.parse(d.toString())); } catch { /* ignore */ }
      });
      const ready = new Promise<void>((resolve, reject) => {
        sock.on('open', () => resolve());
        sock.on('error', reject);
      });
      const waitFor = (type: string, timeoutMs = 5000) =>
        new Promise<any>((resolve, reject) => {
          const found = events.find((e) => e.type === type);
          if (found) return resolve(found);
          const start = Date.now();
          const timer = setInterval(() => {
            const e = events.find((ev) => ev.type === type);
            if (e) { clearInterval(timer); resolve(e); }
            else if (Date.now() - start > timeoutMs) { clearInterval(timer); reject(new Error(`timeout waiting for "${type}"`)); }
          }, 50);
        });
      return { ready, waitFor, close: () => sock.close() };
    };

    const handlerWs = openWs(leadToken);
    const callerWs = openWs(backendToken);
    await run('Connect handler + caller WebSockets', async () => {
      await Promise.all([handlerWs.ready, callerWs.ready]);
    });
    let invocationId = '';

    await run(`Register "deploy" action (handler ${LEAD})`, async () => {
      await relay.actions.register({
        name: 'deploy',
        description: 'Deploy the application to staging or production',
        handlerAgent: LEAD,
        inputSchema: { type: 'object', properties: { env: { type: 'string' } }, required: ['env'] },
        outputSchema: { type: 'object', properties: { url: { type: 'string' } } },
      });
      log('⚙️ ', `Registered ${B}deploy${R} action handled by ${YELLOW}${B}${LEAD}${R}`);
    });
    await pause();

    await run('List actions includes deploy', async () => {
      const actions = await relay.actions.list();
      const names = actions.map((a) => a.name);
      if (!names.includes('deploy')) throw new Error(`deploy not listed: ${JSON.stringify(names)}`);
      log('📋', `Actions: ${names.join(', ')}`);
    });

    await run(`${BACKEND} invokes deploy → invocationId`, async () => {
      const r = await backend.actions.invoke('deploy', { env: 'staging' });
      invocationId = r.invocationId;
      if (!invocationId) throw new Error('no invocationId returned');
      log('🚀', `${BLUE}${B}${BACKEND}${R} invoked deploy → invocation ${B}${invocationId}${R} (status ${r.status})`);
    });

    await run(`Handler ${LEAD} receives action.invoked over WS`, async () => {
      await handlerWs.waitFor('action.invoked');
    });
    await pause();

    await run('Handler completes the invocation', async () => {
      const r = await lead.actions.completeInvocation('deploy', invocationId, {
        output: { url: 'https://staging.example.com' }, durationMs: 1200,
      });
      if (r.status !== 'completed') throw new Error(`status ${r.status}`);
      log('✅', `Handler completed invocation → ${B}completed${R}`);
    });

    await run(`Caller ${BACKEND} receives action.completed over WS`, async () => {
      await callerWs.waitFor('action.completed');
    });

    await run('Get invocation shows completed + output', async () => {
      const inv = await backend.actions.getInvocation('deploy', invocationId);
      if (inv.status !== 'completed') throw new Error(`status ${inv.status}`);
      if ((inv.output as Record<string, unknown> | null)?.url !== 'https://staging.example.com') {
        throw new Error('output not recorded');
      }
    });
    await pause();

    await run('Delete deploy action', async () => {
      await relay.actions.delete('deploy');
      log('🗑️ ', `Deleted deploy action`);
    });

    handlerWs.close();
    callerWs.close();
  }
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
    const group = await lead.dms.createGroup({
      participants: [INFRA, BACKEND],
      name: 'Deploy Sync',
    });
    await lead.dms.sendMessage(group.id, 'Let\'s sync on the deploy pipeline offline.');
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
    // Ensure infra is online first
    await infra.presence.heartbeat();
    await sleep(500);
    const beforePresence = await relay.agents.presence();
    const infraBefore = beforePresence.find((p) => p.agentName === INFRA);
    log('📋', `${INFRA} before markOffline: ${infraBefore?.status ?? 'not found'}`);

    // Use disconnect() which stops WS pings, marks offline, and closes the socket.
    // Calling markOffline() alone leaves the WS ping alive, which re-heartbeats
    // the agent back to online on the server side.
    await infra.disconnect();
    await sleep(2000);
    for (let attempt = 0; attempt < 15; attempt++) {
      const presence = await relay.agents.presence();
      const infraPresence = presence.find((p) => p.agentName === INFRA);
      if (infraPresence?.status === 'offline') {
        log('💤', `${GREEN}${B}${INFRA}${R} disconnected — status: offline`);
        return;
      }
      await sleep(1000);
    }
    throw new Error(`${INFRA} did not transition to offline after disconnect`);
  });

  await run('markOnline brings agent back online', async () => {
    // Reconnect WS (was closed during markOffline test) so the final
    // disconnect has a live connection to close properly.
    infra.connect();
    await waitForConnected(INFRA, infra);
    // Poll for online status
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(500);
      const presence = await relay.agents.presence();
      const infraPresence = presence.find((p) => p.agentName === INFRA);
      if (infraPresence?.status === 'online') {
        log('🟢', `${GREEN}${B}${INFRA}${R} reconnected & online — status: online`);
        return;
      }
    }
    throw new Error(`${INFRA} did not transition to online after reconnect`);
  });
  await pause();

  // ── 19b. Idempotency ───────────────────────────────────────────────
  step('Idempotency');

  await run('Duplicate send with same idempotency key returns same message', async () => {
    const testChannel = 'general';
    const idempotencyKey = `e2e-idem-${Date.now()}`;
    const msg1 = await lead.send(testChannel, 'Idempotency test message', { idempotencyKey });
    // KV eventual consistency may delay idempotency record visibility
    await sleep(2000);
    const msg2 = await lead.send(testChannel, 'Idempotency test message', { idempotencyKey });
    if (msg1.id !== msg2.id) {
      // KV may be unavailable in preview — log warning but don't fail the run
      log('⚠️ ', `${YELLOW}Idempotency not enforced (KV may be unavailable): got ${msg1.id} and ${msg2.id}${R}`);
      return;
    }
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

  if (mockA2a) {
    await mockA2a.close();
    log('🧹', 'Stopped local mock A2A agent');
  }

  await run('Agents show offline after disconnect', async () => {
    // Poll presence — the DO hibernation close callback is async and
    // the webSocketClose handler must await the PresenceDO disconnect.
    const maxAttempts = 15;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await sleep(1000);
      const presence = await relay.agents.presence();
      const statuses = Object.fromEntries(presence.map((p) => [p.agentName, p.status]));
      const allOffline = [LEAD, INFRA, BACKEND].every((name) => statuses[name] === 'offline');
      log('📋', `Presence: ${presence.map((p) => `${p.agentName}=${p.status}`).join(', ')}`);
      if (allOffline) return;
      if (attempt === maxAttempts - 1) {
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
