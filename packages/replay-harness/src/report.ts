import fs from "node:fs/promises";
import path from "node:path";

import type { EquivalenceResult } from "./equivalence.js";

export interface ReplayEvaluation {
  requestId: string;
  method: string;
  path: string;
  targetUrl: string;
  result: EquivalenceResult;
}

export interface ReplayReport {
  corpusUri: string;
  target: string;
  generatedAt: string;
  totals: {
    total: number;
    identical: number;
    allowlisted: number;
    divergent: number;
  };
  results: ReplayEvaluation[];
  divergences: ReplayEvaluation[];
}

export function buildReport(
  corpusUri: string,
  target: string,
  evaluations: ReplayEvaluation[],
): ReplayReport {
  const totals = {
    total: evaluations.length,
    identical: evaluations.filter((entry) => entry.result.kind === "identical").length,
    allowlisted: evaluations.filter((entry) => entry.result.kind === "allowlisted").length,
    divergent: evaluations.filter((entry) => entry.result.kind === "divergent").length,
  };

  return {
    corpusUri,
    target,
    generatedAt: new Date().toISOString(),
    totals,
    results: evaluations,
    divergences: evaluations.filter((entry) => entry.result.kind === "divergent"),
  };
}

export async function writeReport(reportPath: string, report: ReplayReport): Promise<void> {
  const directory = path.dirname(reportPath);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
