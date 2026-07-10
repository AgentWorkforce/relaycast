export function collectConsoleOutput(
  ...spies: Array<{ mock: { calls: unknown[][] } }>
): string {
  return spies
    .flatMap((spy) => spy.mock.calls)
    .flatMap((call) => call)
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
    .join("\n");
}
