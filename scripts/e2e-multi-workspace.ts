#!/usr/bin/env npx tsx
/**
 * Multi-workspace e2e test for MultiWorkspaceSessionManager.
 *
 * Requires two local daemon instances:
 *   packages/local/target/release/local --port 7528 --db-path /tmp/relay-e2e-ws-a.db
 *   packages/local/target/release/local --port 7529 --db-path /tmp/relay-e2e-ws-b.db
 */

import {
  RelayCast,
  AgentClient,
  MultiWorkspaceSessionManager,
  RelayError,
} from '../packages/sdk-typescript/src/index.js';
import type { WsClientEvent, WorkspaceScopedEvent } from '../packages/sdk-typescript/src/index.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const BASE_A = 'http://127.0.0.1:7528';
const BASE_B = 'http://127.0.0.1:7529';

// ---------------------------------------------------------------------------
// Terminal colors
// ---------------------------------------------------------------------------
const R = '\x1b[0m';
const B = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
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
function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------
const passed: string[] = [];
const failed: string[] = [];

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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\n${B}${CYAN}╔══════════════════════════════════════════════════╗
║   Multi-Workspace E2E Test                       ║
╚══════════════════════════════════════════════════╝${R}\n`);

  // ── 1. Create two workspaces ──────────────────────────────────────
  step('Create workspaces on two separate daemons');

  const wsARes = await RelayCast.createWorkspace(`mw-e2e-a-${Date.now()}`, BASE_A);
  const relayA = new RelayCast({ apiKey: wsARes.apiKey, baseUrl: BASE_A });
  log('🏢', `Workspace A: ${B}${wsARes.workspaceId}${R} on ${BASE_A}`);

  const wsBRes = await RelayCast.createWorkspace(`mw-e2e-b-${Date.now()}`, BASE_B);
  const relayB = new RelayCast({ apiKey: wsBRes.apiKey, baseUrl: BASE_B });
  log('🏢', `Workspace B: ${B}${wsBRes.workspaceId}${R} on ${BASE_B}`);

  // ── 2. Register agents in each workspace ──────────────────────────
  step('Register agents');

  const agentARes = await relayA.agents.register({
    name: 'AlphaAgent',
    type: 'agent',
    persona: 'Agent in workspace A',
  });
  log('🤖', `AlphaAgent registered in workspace A`);

  const agentBRes = await relayB.agents.register({
    name: 'BetaAgent',
    type: 'agent',
    persona: 'Agent in workspace B',
  });
  log('🤖', `BetaAgent registered in workspace B`);

  // Create channels
  const agentA = relayA.as(agentARes.token);
  const agentB = relayB.as(agentBRes.token);

  async function ensureChannel(agent: AgentClient, name: string, topic?: string) {
    try {
      await agent.channels.create({ name, ...(topic ? { topic } : {}) });
    } catch (err) {
      if (!(err instanceof RelayError) || err.rawCode !== 'channel_already_exists') throw err;
    }
  }

  await ensureChannel(agentA, 'general', 'Workspace A general');
  await ensureChannel(agentB, 'general', 'Workspace B general');
  log('📢', `#general ensured in both workspaces`);

  await agentA.channels.join('general');
  await agentB.channels.join('general');

  // ── 3. Create MultiWorkspaceSessionManager ────────────────────────
  step('Create MultiWorkspaceSessionManager');

  let manager: MultiWorkspaceSessionManager | null = null;

  await run('Constructor validates memberships', async () => {
    manager = new MultiWorkspaceSessionManager({
      memberships: [
        {
          workspaceId: wsARes.workspaceId,
          workspaceAlias: 'alpha',
          agentToken: agentARes.token,
          agentId: agentARes.agentId,
          agentName: 'AlphaAgent',
          baseUrl: BASE_A,
          channels: ['general'],
        },
        {
          workspaceId: wsBRes.workspaceId,
          workspaceAlias: 'beta',
          agentToken: agentBRes.token,
          agentId: agentBRes.agentId,
          agentName: 'BetaAgent',
          baseUrl: BASE_B,
          channels: ['general'],
        },
      ],
      defaultWorkspaceId: wsARes.workspaceId,
    });

    const status = manager.status();
    if (status.memberships.length !== 2) throw new Error(`Expected 2 memberships, got ${status.memberships.length}`);
    if (status.defaultWorkspaceId !== wsARes.workspaceId) throw new Error('Default workspace mismatch');
  });

  await run('Constructor rejects duplicate workspaceId', async () => {
    try {
      new MultiWorkspaceSessionManager({
        memberships: [
          { workspaceId: 'ws_dup', agentToken: 'tok1', baseUrl: BASE_A },
          { workspaceId: 'ws_dup', agentToken: 'tok2', baseUrl: BASE_B },
        ],
      });
      throw new Error('Expected error for duplicate workspaceId');
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes('Duplicate workspaceId')) {
        throw new Error(`Unexpected error: ${(err as Error).message}`);
      }
    }
  });

  await run('Constructor rejects duplicate workspaceAlias', async () => {
    try {
      new MultiWorkspaceSessionManager({
        memberships: [
          { workspaceId: 'ws_1', workspaceAlias: 'same', agentToken: 'tok1', baseUrl: BASE_A },
          { workspaceId: 'ws_2', workspaceAlias: 'same', agentToken: 'tok2', baseUrl: BASE_B },
        ],
      });
      throw new Error('Expected error for duplicate alias');
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes('Duplicate workspaceAlias')) {
        throw new Error(`Unexpected error: ${(err as Error).message}`);
      }
    }
  });

  await run('Constructor rejects empty memberships', async () => {
    try {
      new MultiWorkspaceSessionManager({ memberships: [] });
      throw new Error('Expected error for empty memberships');
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes('At least one')) {
        throw new Error(`Unexpected error: ${(err as Error).message}`);
      }
    }
  });

  // ── 4. Connect and receive events ─────────────────────────────────
  step('Connect all workspaces');

  const allEvents: WorkspaceScopedEvent<WsClientEvent>[] = [];
  const wsAEvents: WorkspaceScopedEvent<WsClientEvent>[] = [];
  const wsBEvents: WorkspaceScopedEvent<WsClientEvent>[] = [];

  await run('connectAll and receive connected events', async () => {
    const offAny = manager!.onAnyEvent((e) => allEvents.push(e));
    const offA = manager!.onWorkspaceEvent({ workspaceId: wsARes.workspaceId }, (e) => wsAEvents.push(e));
    const offB = manager!.onWorkspaceEvent({ workspaceId: wsBRes.workspaceId }, (e) => wsBEvents.push(e));

    manager!.connectAll();

    // Wait for both connections
    await sleep(3000);

    const status = manager!.status();
    const connectedCount = status.memberships.filter((m) => m.connected).length;
    if (connectedCount !== 2) {
      throw new Error(`Expected 2 connected, got ${connectedCount}. Status: ${JSON.stringify(status)}`);
    }
    log('🔌', `Both workspaces connected`);
  });

  // ── 5. Send messages and verify workspace tagging ─────────────────
  step('Send messages and verify workspace tagging');

  await run('Message to workspace A arrives with correct tagging', async () => {
    // Clear events
    allEvents.length = 0;
    wsAEvents.length = 0;

    await manager!.send({
      workspaceId: wsARes.workspaceId,
      to: 'general',
      message: 'Hello from workspace A',
    });

    await sleep(1500);

    const msgEvents = allEvents.filter(
      (e) => e.event.type === 'message.created' && e.workspaceId === wsARes.workspaceId,
    );
    if (msgEvents.length === 0) {
      throw new Error('No message.created event received for workspace A');
    }
    if (msgEvents[0]!.workspaceAlias !== 'alpha') {
      throw new Error(`Expected alias "alpha", got "${msgEvents[0]!.workspaceAlias}"`);
    }
    log('📨', `Workspace A message tagged correctly (alias=${msgEvents[0]!.workspaceAlias})`);
  });

  await run('Message to workspace B arrives with correct tagging', async () => {
    allEvents.length = 0;
    wsBEvents.length = 0;

    await manager!.send({
      workspaceId: wsBRes.workspaceId,
      to: 'general',
      message: 'Hello from workspace B',
    });

    await sleep(1500);

    const msgEvents = allEvents.filter(
      (e) => e.event.type === 'message.created' && e.workspaceId === wsBRes.workspaceId,
    );
    if (msgEvents.length === 0) {
      throw new Error('No message.created event received for workspace B');
    }
    if (msgEvents[0]!.workspaceAlias !== 'beta') {
      throw new Error(`Expected alias "beta", got "${msgEvents[0]!.workspaceAlias}"`);
    }
    log('📨', `Workspace B message tagged correctly (alias=${msgEvents[0]!.workspaceAlias})`);
  });

  // ── 6. Workspace-aware send (alias, default, ambiguous) ───────────
  step('Workspace-aware send resolution');

  await run('Send via workspaceAlias resolves correctly', async () => {
    const msg = await manager!.send({
      workspaceAlias: 'beta',
      to: 'general',
      message: 'Sent via alias "beta"',
    });
    if (!msg.id) throw new Error('No message ID returned');
    log('📨', `Alias send returned message ${msg.id}`);
  });

  await run('Send without workspace uses default', async () => {
    const msg = await manager!.send({
      to: 'general',
      message: 'Sent to default workspace',
    });
    if (!msg.id) throw new Error('No message ID returned');
    log('📨', `Default workspace send returned message ${msg.id}`);
  });

  await run('Send without workspace and no default throws ambiguous', async () => {
    // Create a manager with no default
    const noDefaultManager = new MultiWorkspaceSessionManager({
      memberships: [
        { workspaceId: wsARes.workspaceId, agentToken: agentARes.token, baseUrl: BASE_A },
        { workspaceId: wsBRes.workspaceId, agentToken: agentBRes.token, baseUrl: BASE_B },
      ],
    });

    try {
      await noDefaultManager.send({ to: 'general', message: 'ambiguous' });
      throw new Error('Expected ambiguous error');
    } catch (err) {
      if (!(err instanceof RelayError) || !err.message.includes('Ambiguous')) {
        throw new Error(`Expected RelayError with "Ambiguous", got: ${(err as Error).message}`);
      }
    }
    await noDefaultManager.disconnectAll();
  });

  // ── 7. Single-membership manager resolves without default ─────────
  step('Single membership auto-resolution');

  await run('Single membership resolves without explicit workspace', async () => {
    const singleManager = new MultiWorkspaceSessionManager({
      memberships: [
        {
          workspaceId: wsARes.workspaceId,
          agentToken: agentARes.token,
          baseUrl: BASE_A,
          channels: ['general'],
        },
      ],
    });

    singleManager.connectAll();
    await sleep(2000);

    const msg = await singleManager.send({ to: 'general', message: 'Single workspace auto-resolve' });
    if (!msg.id) throw new Error('No message ID');
    log('📨', `Single-membership auto-resolved, message ${msg.id}`);

    await singleManager.disconnectAll();
  });

  // ── 8. Subscribe/unsubscribe ──────────────────────────────────────
  step('Dynamic subscribe/unsubscribe');

  await run('Subscribe to new channel on workspace A', async () => {
    await agentA.channels.create({ name: 'ops' });
    await agentA.channels.join('ops');

    manager!.subscribe({ workspaceId: wsARes.workspaceId }, ['ops']);
    const status = manager!.status();
    const wsAStatus = status.memberships.find((m) => m.workspaceId === wsARes.workspaceId);
    if (!wsAStatus?.channels.includes('ops')) {
      throw new Error(`Expected "ops" in channels, got: ${wsAStatus?.channels}`);
    }
  });

  await run('Unsubscribe from channel on workspace A', async () => {
    manager!.unsubscribe({ workspaceId: wsARes.workspaceId }, ['ops']);
    const status = manager!.status();
    const wsAStatus = status.memberships.find((m) => m.workspaceId === wsARes.workspaceId);
    if (wsAStatus?.channels.includes('ops')) {
      throw new Error(`"ops" still in channels after unsubscribe`);
    }
  });

  // ── 9. agentFor ───────────────────────────────────────────────────
  step('agentFor workspace access');

  await run('agentFor returns correct agent per workspace', async () => {
    const aAgent = manager!.agentFor({ workspaceId: wsARes.workspaceId });
    const bAgent = manager!.agentFor({ workspaceAlias: 'beta' });

    // Verify they can independently list channels
    const aChannels = await aAgent.channels.list();
    const bChannels = await bAgent.channels.list();

    if (aChannels.length === 0) throw new Error('Workspace A has no channels');
    if (bChannels.length === 0) throw new Error('Workspace B has no channels');
    log('📋', `Workspace A channels: ${aChannels.length}, Workspace B channels: ${bChannels.length}`);
  });

  await run('agentFor with unknown workspace throws', async () => {
    try {
      manager!.agentFor({ workspaceId: 'ws_nonexistent' });
      throw new Error('Expected not_found error');
    } catch (err) {
      if (!(err instanceof RelayError) || err.code !== 'not_found') {
        throw new Error(`Expected RelayError(not_found), got: ${(err as Error).message}`);
      }
    }
  });

  // ── 10. Disconnect/reconnect cycle ────────────────────────────────
  step('Disconnect/reconnect cycle (Devin bug fix)');

  await run('disconnectAll marks all workspaces offline', async () => {
    await manager!.disconnectAll();
    await sleep(500);

    const status = manager!.status();
    const connected = status.memberships.filter((m) => m.connected);
    if (connected.length !== 0) {
      throw new Error(`Expected 0 connected after disconnect, got ${connected.length}`);
    }
    log('🔌', 'All workspaces disconnected');
  });

  await run('connectAll reconnects all workspaces', async () => {
    manager!.connectAll();
    await sleep(3000);

    const status = manager!.status();
    const connected = status.memberships.filter((m) => m.connected);
    if (connected.length !== 2) {
      throw new Error(`Expected 2 connected after reconnect, got ${connected.length}`);
    }
    log('🔌', 'All workspaces reconnected');
  });

  await run('Messages work after reconnect', async () => {
    allEvents.length = 0;

    await manager!.send({
      workspaceId: wsARes.workspaceId,
      to: 'general',
      message: 'Post-reconnect message',
    });

    await sleep(1500);

    const msgEvents = allEvents.filter((e) => e.event.type === 'message.created');
    if (msgEvents.length === 0) {
      throw new Error('No message events after reconnect');
    }
    log('📨', 'Message delivered successfully after reconnect');
  });

  // ── 11. status() shape ────────────────────────────────────────────
  step('status() contract');

  await run('status returns expected shape', async () => {
    const status = manager!.status();
    if (!status.defaultWorkspaceId) throw new Error('Missing defaultWorkspaceId');
    if (!Array.isArray(status.memberships)) throw new Error('memberships not an array');

    for (const m of status.memberships) {
      if (!m.workspaceId) throw new Error('membership missing workspaceId');
      if (typeof m.connected !== 'boolean') throw new Error('membership.connected not boolean');
      if (!Array.isArray(m.channels)) throw new Error('membership.channels not array');
    }

    const alphaM = status.memberships.find((m) => m.workspaceAlias === 'alpha');
    const betaM = status.memberships.find((m) => m.workspaceAlias === 'beta');
    if (!alphaM) throw new Error('Missing alpha membership in status');
    if (!betaM) throw new Error('Missing beta membership in status');
    if (alphaM.agentName !== 'AlphaAgent') throw new Error(`Expected agentName "AlphaAgent", got "${alphaM.agentName}"`);
    if (betaM.agentName !== 'BetaAgent') throw new Error(`Expected agentName "BetaAgent", got "${betaM.agentName}"`);
  });

  // ── Cleanup ───────────────────────────────────────────────────────
  step('Cleanup');
  await manager!.disconnectAll();
  log('🧹', 'Disconnected all workspace sessions');

  // ── Summary ───────────────────────────────────────────────────────
  console.log(`\n${B}${'═'.repeat(54)}${R}`);
  console.log(`${B}${GREEN} PASSED: ${passed.length}${R}`);
  if (failed.length > 0) {
    console.log(`${B}${RED} FAILED: ${failed.length}${R}`);
    for (const f of failed) {
      console.log(`   ${RED}• ${f}${R}`);
    }
  }
  console.log(`${B}${'═'.repeat(54)}${R}\n`);

  return { passed, failed };
}

main()
  .then(({ failed }) => {
    process.exit(failed.length > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
