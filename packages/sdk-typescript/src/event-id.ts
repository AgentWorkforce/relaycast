function hashStringParts(parts: string[]): [number, number, number, number] {
  const input = JSON.stringify(parts);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  let h3 = 0xc0decafe;
  let h4 = 0x9e3779b9;

  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
    h3 = Math.imul(h3 ^ code, 2246822507);
    h4 = Math.imul(h4 ^ code, 3266489909);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h3 ^ (h3 >>> 13), 3266489909);
  h3 = Math.imul(h3 ^ (h3 >>> 16), 2246822507) ^ Math.imul(h4 ^ (h4 >>> 13), 3266489909);
  h4 = Math.imul(h4 ^ (h4 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

function formatUuidFromWords(words: [number, number, number, number]): string {
  const bytes = new Uint8Array(16);

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    const offset = i * 4;
    bytes[offset] = (word >>> 24) & 0xff;
    bytes[offset + 1] = (word >>> 16) & 0xff;
    bytes[offset + 2] = (word >>> 8) & 0xff;
    bytes[offset + 3] = word & 0xff;
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

export function stableRelaycastEventId(...parts: Array<string | null | undefined>): string {
  const normalized = parts
    .map((part) => part?.trim())
    .filter((part): part is string => typeof part === 'string' && part.length > 0);

  if (normalized.length === 0) {
    return formatUuidFromWords(hashStringParts(['relaycast', 'empty-event']));
  }

  return formatUuidFromWords(hashStringParts(['relaycast', ...normalized]));
}
