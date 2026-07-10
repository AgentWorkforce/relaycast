import { redactText } from "@/lib/ricky/redaction";

const RUN_OUTPUT_SECRET_PATTERNS: readonly RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /relay_(?:pa|ws)_[A-Za-z0-9._-]+/g,
  /x-access-token:[^@\s/'"]+/gi,
];

export function redactRunOutputSecretPatterns(text: string): string {
  let redacted = text;
  for (const pattern of RUN_OUTPUT_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => {
      const sep = match.indexOf(":");
      return sep === -1 ? "[REDACTED]" : `${match.slice(0, sep)}:[REDACTED]`;
    });
  }
  return redacted;
}

export function redactRunOutputForDiagnostics(text: string): string {
  return redactRunOutputSecretPatterns(redactText(text));
}

export function runOutputTailForDiagnostics(
  output: string,
  options: {
    maxLines: number;
    maxBytes: number;
  },
): string {
  if (!output) return "";
  const tail = redactRunOutputForDiagnostics(output)
    .split("\n")
    .slice(-options.maxLines)
    .join("\n");
  return truncateText(tail, options.maxBytes);
}

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}
