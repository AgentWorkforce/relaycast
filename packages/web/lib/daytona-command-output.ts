export type DaytonaCommandOutputResult = {
  result?: string | null;
  artifacts?: {
    stdout?: string | null;
    stderr?: string | null;
  } | null;
};

export function daytonaCommandOutput(result: DaytonaCommandOutputResult): string {
  const stdout = typeof result.artifacts?.stdout === "string" ? result.artifacts.stdout : "";
  const stderr = typeof result.artifacts?.stderr === "string" ? result.artifacts.stderr : "";
  const artifactOutput = joinSplitArtifacts(stdout, stderr);
  if (typeof result.result === "string") {
    return result.result || artifactOutput;
  }
  return artifactOutput;
}

function joinSplitArtifacts(stdout: string, stderr: string): string {
  if (stdout && stderr) {
    // Daytona split artifacts do not carry stdout/stderr interleave ordering.
    // Preserve both streams for diagnostics; callers that require ordered logs
    // must use a merged `result` response path.
    return stdout.endsWith("\n") || stderr.startsWith("\n")
      ? `${stdout}${stderr}`
      : `${stdout}\n${stderr}`;
  }
  return stdout || stderr;
}
