const SLACK_ID_WITH_SUFFIX = /^([CDG](?=[A-Z0-9]*\d)[A-Z0-9]{2,})__(?=.+)/u;

export function normalizeSlackChannelId(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  const match = trimmed.match(SLACK_ID_WITH_SUFFIX);
  return match?.[1] ?? trimmed;
}
