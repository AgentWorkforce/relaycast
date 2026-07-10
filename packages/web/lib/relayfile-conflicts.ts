import { readdir } from "node:fs/promises";
import path from "node:path";

export type RelayfileConflictSummary = {
  conflictCount: number;
  conflictsDir: string;
};

export function resolveRelayfileConflictsDir(localDir: string): string {
  return path.join(localDir, ".relay", "conflicts");
}

export async function countRelayfileConflicts(localDir: string): Promise<RelayfileConflictSummary> {
  const conflictsDir = resolveRelayfileConflictsDir(localDir);
  try {
    const entries = await readdir(conflictsDir, { withFileTypes: true });
    return {
      conflictCount: entries.filter((entry) => entry.isFile()).length,
      conflictsDir,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { conflictCount: 0, conflictsDir };
    }
    throw error;
  }
}
