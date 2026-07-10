/**
 * Daytona volume cleanup script.
 *
 * Deletes volumes that haven't been used in MAX_AGE_DAYS (default: 2).
 * Targets workflow code volumes (name starts with "code-") by default;
 * set INCLUDE_ALL_VOLUMES=1 to sweep every volume in the org.
 *
 * Usage (from repo root):
 *   DAYTONA_API_KEY=xxx node scripts/cleanup-volumes.mjs
 *   DAYTONA_API_KEY=xxx DRY_RUN=1 node scripts/cleanup-volumes.mjs
 *   SST_STAGE=your-stage npx sst shell -- node scripts/cleanup-volumes.mjs
 */

import { Daytona } from '@daytonaio/sdk';

const MAX_AGE_DAYS = parseInt(process.env.MAX_AGE_DAYS ?? '2', 10);
const DRY_RUN = process.env.DRY_RUN === '1';
const INCLUDE_ALL_VOLUMES = process.env.INCLUDE_ALL_VOLUMES === '1';

if (!process.env.DAYTONA_API_KEY) {
  console.error('Error: DAYTONA_API_KEY is not set');
  process.exit(1);
}

const daytona = new Daytona({ apiKey: process.env.DAYTONA_API_KEY });
const cutoffMs = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
const now = Date.now();

console.log(`Volume cleanup — max age: ${MAX_AGE_DAYS}d, dry run: ${DRY_RUN}, all volumes: ${INCLUDE_ALL_VOLUMES}`);

const volumes = await daytona.volume.list();
console.log(`Found ${volumes.length} total volumes`);

let deleted = 0;
let retained = 0;
let skipped = 0;
let errors = 0;

for (const vol of volumes) {
  // By default only clean up workflow code volumes (name: code-XXXXXXXX)
  if (!INCLUDE_ALL_VOLUMES && !vol.name.startsWith('code-')) {
    skipped++;
    continue;
  }

  const lastActivity = vol.lastUsedAt ?? vol.updatedAt ?? vol.createdAt;
  const ageMs = lastActivity ? now - new Date(lastActivity).getTime() : Infinity;
  const ageDays = Math.round(ageMs / 86_400_000);

  if (ageMs > cutoffMs) {
    if (DRY_RUN) {
      console.log(`[dry-run] Would delete: ${vol.name} (${vol.state}, age: ${ageDays}d, last used: ${lastActivity ?? 'unknown'})`);
      deleted++;
    } else {
      try {
        await daytona.volume.delete(vol);
        console.log(`Deleted: ${vol.name} (${vol.state}, age: ${ageDays}d)`);
        deleted++;
      } catch (err) {
        const msg = err?.message ?? String(err);
        if (msg.includes('in use') || msg.includes('mounted')) {
          console.log(`Skipped (in use): ${vol.name} (age: ${ageDays}d)`);
          retained++;
        } else {
          console.error(`Failed to delete ${vol.name}:`, msg);
          errors++;
        }
      }
    }
  } else {
    console.log(`Retained: ${vol.name} (${vol.state}, age: ${ageDays}d)`);
    retained++;
  }
}

console.log(`\nSummary: total=${volumes.length}, ${DRY_RUN ? 'would_delete' : 'deleted'}=${deleted}, retained=${retained}, skipped=${skipped}, errors=${errors}`);

if (errors > 0) process.exit(1);
