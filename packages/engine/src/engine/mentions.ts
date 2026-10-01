/** Shared by live delivery and durable replay; emails and escaped handles are not mentions. */
export function parseMessageMentions(text: string): string[] {
  return [...new Set([...text.matchAll(/(?:^|\s)@([\w-]+)/g)].map(match => match[1]))];
}
