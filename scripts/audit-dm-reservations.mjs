#!/usr/bin/env node
/**
 * Pre-flight audit for migration 0033 (dm_conversation_reservations).
 *
 * READ-ONLY. Run this against a production replica BEFORE applying 0033.
 *
 * WHY THIS EXISTS AS A SCRIPT AND NOT SQL
 * ───────────────────────────────────────
 * The interesting check needs SHA-256 to recompute the deterministic
 * conversation id, and SQLite does not have it. It is also the check whose
 * failure is INVISIBLE AT MIGRATION TIME:
 *
 *   (b) duplicate pair    -> migration aborts loudly. You find out immediately.
 *   (c) id != derivation  -> migration SUCCEEDS, and then every subsequent DM
 *                            between that pair returns 409 forever, because the
 *                            backfill reserved the pair under an id the send
 *                            path will never re-derive.
 *
 * IT ALSO EARNED ITS KEEP. Run against production it found 4 colliding pair
 * groups and 30 mismatched ids that would have aborted the deployment. All 30
 * were ORPHANED TWO-PARTY conversations, not self-DMs: `dm_participants.agent_id`
 * cascades on agent deletion, so an ordinary 1:1 collapses to a one-row roster
 * while its id still encodes the original pair. The backfill was reading those
 * as (X, X). Migration 0033 now reserves only exactly-two-participant
 * conversations, and the same production data yields zero findings.
 *
 * So one-row rosters are reported, not flagged — and the derivation is used to
 * say which are genuine self-DMs and which are orphans, since the roster alone
 * cannot tell them apart.
 *
 * Git history says the derivation never changed — the only edit swapped node
 * crypto for web crypto with a byte-identical input string, and production
 * confirms it: 3425 two-party conversations, zero mismatches. This script exists
 * because "stable in git history" and "zero rows in production disagree" are
 * different claims, and only the second one is evidence.
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

const skipped = [];

for (const conv of conversations.values()) {
  const agents = [...conv.agents].sort();

  // Migration 0033 reserves ONLY exactly-two-participant conversations. Anything
  // else is skipped by the backfill, so it cannot abort the migration and cannot
  // create a wrong binding. Recorded, not flagged.
  //
  // A one-row roster is genuinely ambiguous: `dm_participants.agent_id` cascades
  // on agent deletion, so an ordinary two-party 1:1 collapses to one row while
  // its id still encodes the original pair. It is indistinguishable from a real
  // self-DM by roster alone -- but the derivation tells them apart, so this
  // reports which is which.
  if (agents.length !== 2) {
    const solo = agents[0];
    const looksLikeSelfDm = agents.length === 1
      && conv.id === deriveConversationId(conv.workspaceId, solo, solo);
    skipped.push({
      id: conv.id,
      workspaceId: conv.workspaceId,
      participants: agents.length,
      kind: agents.length === 1 ? (looksLikeSelfDm ? 'self-DM' : 'orphaned two-party') : 'malformed',
    });
    if (agents.length === 0 || agents.length > 2) {
      malformed.push({ id: conv.id, workspaceId: conv.workspaceId, participants: agents.length });
    }
    continue;
  }

  const [first, second] = agents;

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

const reserved = conversations.size - skipped.length;
console.log(`  ${reserved} will be reserved by the backfill; ${skipped.length} skipped (not exactly two participants).\n`);

let findings = 0;
section('(a) malformed rosters — skipped by the backfill, but worth knowing about', malformed,
  (m) => `${m.id} (workspace ${m.workspaceId}, ${m.participants} participants)`);
findings += section('(b) duplicate pairs among reserved conversations — migration will ABORT', duplicates,
  (d) => `${d.pair} -> ${d.conversations.join(', ')}`);
findings += section('(c) id does not match the current derivation — migration SUCCEEDS, then DMs 409', mismatched,
  (m) => `${m.id} should be ${m.expected} (workspace ${m.workspaceId}, pair ${m.pair.join(' + ')})`);

const byKind = skipped.reduce((acc, s) => ({ ...acc, [s.kind]: (acc[s.kind] ?? 0) + 1 }), {});
if (skipped.length > 0) {
  console.log('');
  console.log('  skipped breakdown (informational — none of these block the migration):');
  for (const [kind, count] of Object.entries(byKind)) console.log(`    ${count} ${kind}`);
  if (byKind['orphaned two-party']) {
    console.log('    an orphaned two-party 1:1 is one whose peer agent was deleted;');
    console.log('    dm_participants cascades on agent delete, leaving a one-row roster.');
  }
}

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
