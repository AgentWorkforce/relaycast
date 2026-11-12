/**
 * The import protocol between `relaycast-migrate import` and a workspace
 * actor, carried by `POST /internal/workspaces/:id/import` (internal secret).
 *
 *   begin   { run_id, tables: [{ name, columns }] }      start, or resume the same run
 *   chunk   { run_id, table, seq, rows }                 idempotent per (table, seq)
 *   finish  { run_id, manifest: { <table>: digest } }    verify (still closed); replays for the run
 *   open    { run_id }                                   go-live: serve the verified workspace
 *   abort   { run_id }                                   remove everything imported (before open)
 *   status  {}                                           the import state
 *
 * Tables are sent in plan order (`migrationPlan`), and `begin` refuses unless
 * the exporter's column lists equal the actor's for every table, so source and
 * target run the same engine schema.
 */
import { z } from 'zod';

export const IMPORT_RUN_ID = /^[A-Za-z0-9_-]{8,64}$/;

const runId = z.string().regex(IMPORT_RUN_ID, 'run_id must be 8-64 URL-safe characters');
const value = z.union([z.string(), z.number(), z.null()]);
const digest = z.object({ count: z.number().int().min(0), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();

export const ImportRequestSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('begin'),
    run_id: runId,
    tables: z.array(z.object({ name: z.string().min(1), columns: z.array(z.string().min(1)) }).strict()).min(1),
  }).strict(),
  z.object({
    op: z.literal('chunk'),
    run_id: runId,
    table: z.string().min(1),
    seq: z.number().int().min(0),
    rows: z.array(z.array(value).min(1)).min(1),
  }).strict(),
  z.object({
    op: z.literal('finish'),
    run_id: runId,
    manifest: z.record(z.string(), digest),
  }).strict(),
  z.object({ op: z.literal('open'), run_id: runId }).strict(),
  z.object({ op: z.literal('abort'), run_id: runId }).strict(),
  z.object({ op: z.literal('status') }).strict(),
]);

export type ImportRequest = z.infer<typeof ImportRequestSchema>;

/** Largest import request body the gateway accepts (the CLI's chunks stay well under). */
export const MAX_IMPORT_BODY_BYTES = 8 * 1024 * 1024;

/** The engine error code a workspace answers every other request with while an import runs. */
export const WORKSPACE_IMPORTING_CODE = 'workspace_importing';
