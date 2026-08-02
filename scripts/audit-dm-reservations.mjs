#!/usr/bin/env node
/**
 * Pre-flight audit for migration 0033 (dm_conversation_reservations).
 *
 * READ-ONLY. Run this against a production replica BEFORE applying 0033.
 *
 * WHY THIS EXISTS AS A SCRIPT AND NOT SQL
 * ───────────────────────────────────────
 * Two of the three checks are plain SQL and live in the migration header. The
 * third cannot be: it has to recompute the deterministic conversation id, and
 * SQLite has no SHA-256. It is also the check that matters most operationally,
 * because it is the only one whose failure is INVISIBLE AT MIGRATION TIME.
 *
 *   (a) malformed roster   -> migration aborts loudly. You find out immediately.
 *   (b) duplicate pair     -> migration aborts loudly. You find out immediately.
 *   (c) id != derivation   -> migration SUCCEEDS, and then every subsequent DM
 *                             between that pair returns 409 forever.
 *
 * (c) happens because the backfill reserves whatever `dc.id` a conversation
 * already had. If that id is not what `deriveDmPairKey` produces today, the next
 * send derives a different id for the same pair, hits the pair-uniqueness index,
 * and fails closed. The pair can never DM again.
 *
 * Git history says the derivation never changed — the only edit swapped node
 * crypto for web crypto with a byte-identical input string. This script exists
 * because "the derivation looks stable in git history" and "zero rows in
 * production disagree" are different claims, and only the second one is
 * evidence.
 *
 * USAGE
 * ─────
 *   Self-hosted (SQLite file):
 *     node scripts/audit-dm-reservations.mjs --sqlite /path/to/relay.db
 *
 *   Hosted (Cloudflare D1) — feed it the rows, since D1 is not a local file:
 *     wrangler d1 execute <DB> --json --command \
 *       "SELECT dc.id, dc.workspace_id, dp.agent_id \
 *        FROM dm_conversations dc \
 *        JOIN dm_participants dp ON dp.conversation_id = dc.id \
 *        WHERE dc.dm_type = '1:1'" \
 *       | node scripts/audit-dm-reservations.mjs --stdin
 *
 * Exit codes: 0 = clean, 1 = findings, 2 = usage/read error.
 */

import { createHash } from 'node:crypto';

/** Must stay byte-identical to `deriveDmPairKey` in packages/engine/src/engine/dm.ts. */
function deriveConversationId(workspaceId, agentA, agentB) {
  const [first, second] = [agentA, agentB].sort();
  const key = createHash('sha256')
    .update(`${workspaceId}:${first}:${second}`)
    .digest('hex')
    .slice(0, 24);
  return `dm_${key}`;
}

function usage(message) {
  if (message) console.error(`error: ${message}\n`);
  console.error('usage: audit-dm-reservations.mjs --sqlite <path> | --stdin');
  process.exit(2);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Normalise either input source to [{ id, workspace_id, agent_id }]. */
async function loadRows(argv) {
  if (argv.includes('--stdin')) {
    const raw = await readStdin();
    if (!raw.trim()) usage('nothing on stdin');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      usage('stdin was not JSON (expected `wrangler d1 execute --json` output)');
    }
    // wrangler wraps results as [{ results: [...] }]; accept a bare array too.
    const rows = Array.isArray(parsed)
      ? (parsed[0]?.results ?? parsed)
      : (parsed.results ?? parsed.result?.[0]?.results);
    if (!Array.isArray(rows)) usage('could not find a results array in the JSON');
    return rows;
  }

  const i = argv.indexOf('--sqlite');
  if (i === -1 || !argv[i + 1]) usage('pass --sqlite <path> or --stdin');
  const path = argv[i + 1];

  let Database;
  try {
    ({ default: Database } = await import('better-sqlite3'));
  } catch {
    usage('better-sqlite3 is not installed here; use --stdin instead');
  }
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(`
      SELECT dc.id AS id, dc.workspace_id AS workspace_id, dp.agent_id AS agent_id
      FROM dm_conversations dc
      JOIN dm_participants dp ON dp.conversation_id = dc.id
      WHERE dc.dm_type = '1:1'
    `).all();
  } finally {
    db.close();
  }
}

const rows = await loadRows(process.argv.slice(2));

// Group the roster per conversation.
const conversations = new Map();
for (const row of rows) {
  const id = row.id ?? row.conversation_id;
  const workspaceId = row.workspace_id;
  const agentId = row.agent_id;
  if (!id || !workspaceId || !agentId) continue;
  if (!conversations.has(id)) conversations.set(id, { id, workspaceId, agents: new Set() });
  conversations.get(id).agents.add(agentId);
}

const malformed = [];
const mismatched = [];
const pairIndex = new Map(); // workspace|a|b -> [conversationId]

for (const conv of conversations.values()) {
  const agents = [...conv.agents].sort();

  // (a) roster shape. A self-DM legitimately has one participant.
  if (agents.length < 1 || agents.length > 2) {
    malformed.push({ id: conv.id, workspaceId: conv.workspaceId, participants: agents.length });
    continue;
  }

  const [first, second] = agents.length === 2 ? agents : [agents[0], agents[0]];

  // (b) duplicate pair within a workspace.
  const pairKey = `${conv.workspaceId}|${first}|${second}`;
  if (!pairIndex.has(pairKey)) pairIndex.set(pairKey, []);
  pairIndex.get(pairKey).push(conv.id);

  // (c) the one only this script can check.
  const expected = deriveConversationId(conv.workspaceId, first, second);
  if (conv.id !== expected) {
    mismatched.push({ id: conv.id, expected, workspaceId: conv.workspaceId, pair: [first, second] });
  }
}

const duplicates = [...pairIndex.entries()]
  .filter(([, ids]) => ids.length > 1)
  .map(([key, ids]) => ({ pair: key, conversations: ids }));

// ── report ───────────────────────────────────────────────────────────────────
console.log(`Scanned ${conversations.size} 1:1 conversation(s).\n`);

const section = (label, items, render) => {
  if (items.length === 0) {
    console.log(`  ok    ${label}: none`);
    return 0;
  }
  console.log(`  FAIL  ${label}: ${items.length}`);
  for (const item of items.slice(0, 20)) console.log(`          ${render(item)}`);
  if (items.length > 20) console.log(`          ... and ${items.length - 20} more`);
  return items.length;
};

let findings = 0;
findings += section('(a) malformed rosters — migration will ABORT', malformed,
  (m) => `${m.id} (workspace ${m.workspaceId}, ${m.participants} participants)`);
findings += section('(b) duplicate pairs — migration will ABORT', duplicates,
  (d) => `${d.pair} -> ${d.conversations.join(', ')}`);
findings += section('(c) id does not match the current derivation — migration SUCCEEDS, then DMs 409', mismatched,
  (m) => `${m.id} should be ${m.expected} (workspace ${m.workspaceId}, pair ${m.pair.join(' + ')})`);

console.log('');
if (findings === 0) {
  console.log('Clean. Migration 0033 will apply, and no existing pair will start failing afterwards.');
  process.exit(0);
}

console.log(`${findings} finding(s). Remediate before applying migration 0033.`);
console.log('');
console.log('  (a) decide the correct roster for each conversation.');
console.log('  (b) decide which conversation survives — a pair can hold only one reservation.');
console.log('  (c) THIS IS THE QUIET ONE. The migration will not complain, but every');
console.log('      subsequent DM between that pair returns 409. Either re-key the');
console.log('      conversation to the derived id, or seed its reservation under the');
console.log('      derived id, before deploying the code that reserves.');
process.exit(1);
