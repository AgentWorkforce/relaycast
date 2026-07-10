const SECRET_KEY_PATTERN =
  /^(anthropic|openai|opencode|openrouter|google|aws)$|(?:secret|token|credential|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|refresh[_-]?token|session[_-]?token|authorization|cookie)/i;

const SECRET_TEXT_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /(OPENAI|ANTHROPIC|OPENROUTER|GOOGLE|AWS|S3|DAYTONA|RELAY)[A-Z0-9_]*(?:API)?_?(?:KEY|TOKEN|SECRET|CREDENTIALS?)\s*[:=]\s*["']?[^"'\s,}]+/gi,
  /"?(?:anthropic|openai|opencode|openrouter|google|aws)"?\s*:\s*"[^"]+"/gi,
  /"?(?:access_token|refresh_token|api_key|secret|password|private_key|client_secret|credential_json)"?\s*:\s*"(?:\\.|[^"\\])*"/gi,
  /AKIA[0-9A-Z]{16}/g,
];

export function redactText(input: string): string {
  const withoutCredentialJson = redactCredentialJsonObjects(input);

  return SECRET_TEXT_PATTERNS.reduce(
    (value, pattern) => value.replace(pattern, (match) => {
      const separator = match.includes(":") ? ":" : match.includes("=") ? "=" : "";
      if (!separator) return "[REDACTED]";
      const [key] = match.split(separator);
      return `${key}${separator}[REDACTED]`;
    }),
    withoutCredentialJson,
  );
}

function redactCredentialJsonObjects(input: string): string {
  const pattern = /("?credential_json"?\s*:\s*)\{/gi;
  let output = "";
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(input)) !== null) {
    const keyPrefix = match[1];
    const objectStart = match.index + match[0].length - 1;
    const objectEnd = findJsonObjectEnd(input, objectStart);
    output += input.slice(cursor, match.index);
    if (objectEnd === -1) {
      output += `${keyPrefix}[REDACTED]`;
      cursor = input.length;
      break;
    }
    output += `${keyPrefix}[REDACTED]`;
    cursor = objectEnd + 1;
    pattern.lastIndex = cursor;
  }

  return output + input.slice(cursor);
}

function findJsonObjectEnd(input: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < input.length; index += 1) {
    const char = input[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

export function redactForRicky<T>(value: T): T {
  return redactUnknown(value) as T;
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : redactUnknown(nested);
  }
  return out;
}

export function parseAndRedactJson(raw: string): unknown {
  try {
    return redactForRicky(JSON.parse(raw));
  } catch {
    return redactText(raw);
  }
}
