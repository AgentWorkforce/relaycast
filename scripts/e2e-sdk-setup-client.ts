#!/usr/bin/env -S npx tsx

import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RelaycastSetup,
  type AgentClient,
  type WorkspaceHandle,
} from '../packages/sdk-typescript/src/index.js';

const DEFAULT_BASE_URL = 'http://localhost:8787';
const ON_MESSAGE_TIMEOUT_MS = 5_000;

type StepResult = Record<string, unknown> | string | number | boolean | null | undefined;
type WorkspaceRelay = ReturnType<WorkspaceHandle['relay']>;

interface RuntimeContext {
  tempDir: string;
  workspaceIdPath: string;
  workspaceKeyPath: string;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function logStep(name: string): void {
  console.log(`\n[step] ${name}`);
}

function logOk(name: string, detail?: StepResult): void {
  console.log(`[ok] ${name}`);
  if (detail !== undefined) {
    console.log(JSON.stringify(detail, null, 2));
  }
}

function fail(step: string, message: string): never {
  throw new Error(`${step}: ${message}`);
}

function assert(condition: unknown, step: string, message: string): asserts condition {
  if (!condition) {
    fail(step, message);
  }
}

async function runStep<T>(name: string, work: () => Promise<T>): Promise<T> {
  logStep(name);
  try {
    const result = await work();
    logOk(name, result as StepResult);
    return result;
  } catch (error) {
    throw new Error(`${name} failed: ${formatError(error)}`);
  }
}

async function checkHealth(baseUrl: string): Promise<void> {
  const url = new URL('/health', `${baseUrl}/`);
  try {
    const response = await fetch(url);
    if (!response.ok) {
      fail('health', `expected ${url.toString()} to return 2xx, got ${response.status}`);
    }
  } catch (error) {
    fail(
      'health',
      `could not reach ${url.toString()} (${formatError(error)}). ` +
      'Pass a reachable base URL as the first argument, for example: ' +
      '`npx tsx scripts/e2e-sdk-setup-client.ts http://localhost:8787`',
    );
  }
}

async function waitForMessage(
  relay: WorkspaceRelay,
  matcher: (message: { sender: string; text: string; channel?: string }) => boolean,
  timeoutMs: number,
): Promise<{ sender: string; text: string; channel?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out after ${timeoutMs}ms waiting for relay.onMessage()`)); // clear setup-path failure
    }, timeoutMs);

    const unsubscribe = relay.onMessage((message) => {
      if (!matcher(message)) {
        return;
      }
      clearTimeout(timer);
      unsubscribe();
      resolve(message);
    });
  });
}

async function waitForConnected(agent: AgentClient, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out after ${timeoutMs}ms waiting for AgentClient websocket connection`));
    }, timeoutMs);

    const unsubscribe = agent.on.connected(() => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

async function createRuntime(): Promise<RuntimeContext> {
  const tempDir = await mkdtemp(join(tmpdir(), 'relaycast-sdk-setup-client-'));
  return {
    tempDir,
    workspaceIdPath: join(tempDir, 'workspace-id'),
    workspaceKeyPath: join(tempDir, 'workspace-key'),
  };
}

async function main(): Promise<void> {
  const baseUrl = normalizeBaseUrl(process.argv[2] ?? DEFAULT_BASE_URL);
  const runtime = await createRuntime();
  const runId = randomUUID().slice(0, 8);
  const workspaceName = `e2e-sdk-setup-${runId}`;
  const channelText = `channel-post-${runId}`;
  const dmText = `direct-message-${runId}`;

  console.log('[config]');
  console.log(JSON.stringify({
    baseUrl,
    tempDir: runtime.tempDir,
  }, null, 2));

  await runStep('check server health', async () => {
    await checkHealth(baseUrl);
    return { healthUrl: `${baseUrl}/health` };
  });

  const setup = new RelaycastSetup({ baseUrl });
  let workspace: WorkspaceHandle | null = null;
  await runStep('createWorkspace', async () => {
    const created = await setup.createWorkspace({
      name: workspaceName,
      expiresInSeconds: 24 * 60 * 60,
      provenance: {
        source: 'ci',
        origin_id: process.env.GITHUB_RUN_ID
          ? `github:AgentWorkforce/relaycast/actions/runs/${process.env.GITHUB_RUN_ID}`
          : 'relaycast:e2e-sdk-setup:local',
        classification: 'internal',
      },
    });
    assert(created.workspaceId, 'createWorkspace', 'workspaceId was empty');
    assert(created.apiKey, 'createWorkspace', 'apiKey was empty');
    assert(created.info.name === workspaceName, 'createWorkspace', 'workspace name did not round-trip');
    workspace = created;
    return {
      workspaceId: created.workspaceId,
      apiKeyPrefix: created.apiKey.slice(0, 12),
      createdAt: created.info.createdAt,
      name: created.info.name,
    };
  });
  assert(workspace, 'createWorkspace', 'workspace handle was not captured');

  await runStep('persist workspace id/key files in temp directory', async () => {
    await writeFile(runtime.workspaceIdPath, workspace.workspaceId, 'utf8');
    await writeFile(runtime.workspaceKeyPath, workspace.apiKey, 'utf8');

    const persistedId = (await readFile(runtime.workspaceIdPath, 'utf8')).trim();
    const persistedKey = (await readFile(runtime.workspaceKeyPath, 'utf8')).trim();

    assert(persistedId === workspace.workspaceId, 'persist workspace id', 'workspace id file did not match');
    assert(persistedKey === workspace.apiKey, 'persist workspace key', 'workspace key file did not match');

    return {
      workspaceIdPath: runtime.workspaceIdPath,
      workspaceKeyPath: runtime.workspaceKeyPath,
    };
  });

  const lookup = await runStep('lookupWorkspace existing + missing', async () => {
    const found = await setup.lookupWorkspace(workspaceName);
    assert(found, 'lookupWorkspace existing', `workspace ${workspaceName} was not found`);
    assert(found.id === workspace.workspaceId, 'lookupWorkspace existing', 'lookup returned the wrong workspace id');

    const missing = await setup.lookupWorkspace(`missing-${workspaceName}`);
    assert(missing === null, 'lookupWorkspace missing', 'missing lookup should return null');

    return {
      foundId: found.id,
      foundName: found.name,
      missing: true,
    };
  });

  const alice = await runStep('registerAgent Alice', async () => {
    const agent = await workspace.registerAgent({ name: 'Alice' });
    assert(agent.token, 'registerAgent Alice', 'Alice token was empty');
    assert(agent.name === 'Alice', 'registerAgent Alice', `expected exact agent name Alice, got ${agent.name}`);
    return { id: agent.id, name: agent.name, status: agent.status };
  });

  const bob = await runStep('registerAgent Bob', async () => {
    const agent = await workspace.registerAgent({ name: 'Bob' });
    assert(agent.token, 'registerAgent Bob', 'Bob token was empty');
    assert(agent.name === 'Bob', 'registerAgent Bob', `expected exact agent name Bob, got ${agent.name}`);
    return { id: agent.id, name: agent.name, status: agent.status };
  });

  assert(alice.id !== bob.id, 'registerAgent Alice/Bob', 'Alice and Bob should have distinct agent ids');

  const aliceToken = workspace.getAgentToken('Alice');
  const bobToken = workspace.getAgentToken('Bob');
  assert(aliceToken, 'getAgentToken Alice', 'Alice token was not stored on the handle');
  assert(bobToken, 'getAgentToken Bob', 'Bob token was not stored on the handle');

  await runStep('listRegisteredAgents', async () => {
    const agents = workspace.listRegisteredAgents();
    assert(agents.length === 2, 'listRegisteredAgents', `expected 2 agents, got ${agents.length}`);
    assert(agents[0]?.name === 'Alice', 'listRegisteredAgents', 'Alice should be first');
    assert(agents[1]?.name === 'Bob', 'listRegisteredAgents', 'Bob should be second');
    return agents.map((agent) => ({ id: agent.id, name: agent.name, type: agent.type }));
  });

  const joinedWorkspace = await runStep('joinWorkspace from live handle credentials', async () => {
    const joined = await setup.joinWorkspace(workspace.workspaceId, workspace.apiKey);
    assert(joined.workspaceId === workspace.workspaceId, 'joinWorkspace', 'workspace id changed on join');
    assert(joined.apiKey === workspace.apiKey, 'joinWorkspace', 'api key changed on join');
    const info = await joined.relayCast().workspace.info();
    assert(info.id === workspace.workspaceId, 'joinWorkspace', 'joined relayCast().workspace.info() returned the wrong workspace');
    return {
      workspaceId: joined.workspaceId,
      name: info.name,
    };
  });

  await runStep('joinWorkspace from persisted temp-dir files', async () => {
    const persistedId = (await readFile(runtime.workspaceIdPath, 'utf8')).trim();
    const persistedKey = (await readFile(runtime.workspaceKeyPath, 'utf8')).trim();
    const joined = await setup.joinWorkspace(persistedId, persistedKey);
    const info = await joined.relayCast().workspace.info();
    assert(info.id === workspace.workspaceId, 'persisted joinWorkspace', 'persisted workspace credentials did not reopen the same workspace');
    return {
      workspaceId: joined.workspaceId,
      workspaceName: info.name,
    };
  });

  await runStep('explicit base URL override', async () => {
    const overrideSetup = new RelaycastSetup({ baseUrl });
    const overrideJoined = await overrideSetup.joinWorkspace(workspace.workspaceId, workspace.apiKey);
    assert(overrideJoined.info.baseUrl === baseUrl, 'baseUrl override', 'explicit baseUrl should be used');
    const info = await overrideJoined.relayCast().workspace.info();
    assert(info.id === workspace.workspaceId, 'baseUrl override', 'join did not reach the target workspace');
    return {
      baseUrl: overrideJoined.info.baseUrl,
      workspaceId: info.id,
    };
  });

  await runStep('createWorkspace idempotent path with apiKey', async () => {
    const ownerSetup = new RelaycastSetup({ baseUrl, apiKey: workspace.apiKey });
    const existing = await ownerSetup.createWorkspace({ name: workspaceName });
    assert(existing.workspaceId === workspace.workspaceId, 'createWorkspace idempotent path', 'owner apiKey did not return the existing workspace');
    return {
      workspaceId: existing.workspaceId,
      name: workspaceName,
    };
  });

  await runStep('relayCast()', async () => {
    const first = workspace.relayCast();
    const second = workspace.relayCast();
    assert(first === second, 'relayCast()', 'relayCast() should return a singleton per handle');
    const info = await first.workspace.info();
    assert(info.id === workspace.workspaceId, 'relayCast()', 'relayCast workspace info did not match');
    return {
      workspaceId: info.id,
      workspaceName: info.name,
    };
  });

  const aliceClient = workspace.as(aliceToken);
  const bobClient = workspace.as(bobToken);
  await runStep('workspace.as()', async () => {
    assert(aliceClient !== workspace.as(aliceToken), 'workspace.as()', 'workspace.as() should return a fresh AgentClient');
    assert(bobClient !== workspace.as(bobToken), 'workspace.as()', 'workspace.as() should return a fresh AgentClient');
    const channels = await aliceClient.channels.list();
    assert(channels.some((channel) => channel.name === 'general'), 'workspace.as()', 'Alice could not see the default #general channel');
    return {
      aliceFreshInstance: true,
      bobFreshInstance: true,
      channelCount: channels.length,
    };
  });

  const aliceRelay = workspace.relay('Alice');
  const bobRelay = workspace.relay('Bob');
  await runStep('relay()', async () => {
    assert(aliceRelay === workspace.relay('Alice'), 'relay()', 'relay() should return a singleton per agent name');
    assert(bobRelay === workspace.relay('Bob'), 'relay()', 'relay() should return a singleton per agent name');
    return {
      aliceRelaySingleton: true,
      bobRelaySingleton: true,
    };
  });

  const channelPost = await runStep('relay.post() to #general', async () => {
    const posted = await aliceRelay.post('#general', channelText);
    assert(posted.id, 'relay.post()', 'channel post did not return a message id');

    const visible = await bobClient.messages('#general', { limit: 10 });
    assert(
      visible.some((message) => message.id === posted.id && message.text === channelText),
      'relay.post()',
      `Bob could not read Alice's channel post "${channelText}"`,
    );

    return {
      messageId: posted.id,
      text: posted.text,
      visibleToBob: true,
    };
  });

  await runStep('relay.send() DM + relay.onMessage()', async () => {
    bobRelay.agents.connect();
    const connected = waitForConnected(bobRelay.agents, ON_MESSAGE_TIMEOUT_MS);

    const waitForBobDm = waitForMessage(
      bobRelay,
      (message) => message.sender === 'Alice' && message.text === dmText,
      ON_MESSAGE_TIMEOUT_MS,
    );

    await connected;

    const dm = await aliceRelay.send('Bob', dmText);
    assert(dm.conversationId, 'relay.send()', 'DM response did not include a conversation id');

    const received = await waitForBobDm;
    assert(received.text === dmText, 'relay.onMessage()', 'Bob received the wrong DM text');

    return {
      conversationId: dm.conversationId,
      sender: received.sender,
      text: received.text,
    };
  });

  await runStep('Bob inbox reflects channel + DM activity', async () => {
    const inbox = await bobRelay.inbox();
    assert(
      inbox.unreadChannels.some((entry) => entry.channelName === 'general' && entry.unreadCount >= 1),
      'relay.inbox()',
      'Bob inbox did not report unread channel activity in #general',
    );
    assert(
      inbox.unreadDms.some((entry) => entry.from === 'Alice' && entry.unreadCount >= 1),
      'relay.inbox()',
      'Bob inbox did not report Alice DM activity',
    );

    return {
      unreadChannels: inbox.unreadChannels,
      unreadDms: inbox.unreadDms,
    };
  });

  await Promise.allSettled([
    aliceClient.disconnect(),
    bobClient.disconnect(),
    bobRelay.agents.disconnect(),
  ]);

  console.log('\n[summary]');
  console.log(JSON.stringify({
    status: 'ok',
    workspaceId: workspace.workspaceId,
    workspaceName,
    lookupId: lookup.foundId,
    joinedWorkspaceId: joinedWorkspace.workspaceId,
    channelMessage: channelPost.messageId,
    tempDir: runtime.tempDir,
    workspaceIdPath: runtime.workspaceIdPath,
    workspaceKeyPath: runtime.workspaceKeyPath,
    artifact: 'scripts/e2e-sdk-setup-client.ts',
  }, null, 2));
  process.exit(0);
}

void main().catch((error) => {
  console.log('\n[summary]');
  console.log(JSON.stringify({
    status: 'failed',
    error: formatError(error),
    artifact: 'scripts/e2e-sdk-setup-client.ts',
  }, null, 2));
  process.exit(1);
});
