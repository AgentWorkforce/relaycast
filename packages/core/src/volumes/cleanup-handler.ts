import { Resource } from "sst";
import { Daytona } from "@daytonaio/sdk";

const MAX_AGE_DAYS = parseInt(process.env.MAX_AGE_DAYS ?? "2", 10);
const cutoffMs = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

export const handler = async (
  _event?: unknown,
): Promise<{ deleted: number; skipped: number; retained: number }> => {
  const daytona = new Daytona({ apiKey: Resource.DaytonaApiKey.value });

  const volumes = await daytona.volume.list();
  console.log(`[volume-cleanup] Found ${volumes.length} volumes, max age: ${MAX_AGE_DAYS}d`);

  const now = Date.now();
  let deleted = 0;
  let skipped = 0;
  let retained = 0;

  for (const vol of volumes) {
    if (!vol.name.startsWith("code-")) {
      skipped++;
      continue;
    }

    const lastActivity = vol.lastUsedAt ?? vol.updatedAt ?? vol.createdAt;
    const ageMs = lastActivity ? now - new Date(lastActivity).getTime() : Infinity;
    const ageDays = Math.round(ageMs / 86_400_000);

    if (ageMs > cutoffMs) {
      try {
        await daytona.volume.delete(vol);
        console.log(`[volume-cleanup] Deleted: ${vol.name} (age: ${ageDays}d)`);
        deleted++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("in use") || msg.includes("mounted")) {
          console.log(`[volume-cleanup] Skipped (in use): ${vol.name} (age: ${ageDays}d)`);
          skipped++;
        } else {
          console.error(`[volume-cleanup] Failed to delete ${vol.name}: ${msg}`);
          skipped++;
        }
      }
    } else {
      retained++;
    }
  }

  console.log(
    `[volume-cleanup] Done — deleted: ${deleted}, retained: ${retained}, skipped: ${skipped}`,
  );

  return { deleted, skipped, retained };
};
