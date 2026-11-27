/** Maximum length of an agent name in characters. */
export const AGENT_NAME_MAX_LENGTH = 128;

/**
 * Printable non-whitespace ASCII (`!` through `~`).
 *
 * Restricting agent names to printable non-whitespace ASCII eliminates
 * whitespace lookalikes (trailing spaces/tabs/NBSP), control characters,
 * zero-width/bidi format characters, Unicode normalization drift, and
 * cross-script homoglyphs (Cyrillic/Greek/fullwidth/etc.) while preserving
 * existing ASCII identifiers (`Alice`, `ops.lead`, `dave@ops`, `worker-1`).
 */
export const AGENT_NAME_PATTERN = /^[\x21-\x7e]+$/;

// C0 controls, DEL, and C1 controls.
const AGENT_NAME_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const AGENT_NAME_WHITESPACE = /\s/u;

export type AgentNameValidationResult =
  | { ok: true; canonical: string }
  | { ok: false; reason: string };

/**
 * Canonical comparison key for an agent name.
 *
 * Applies Unicode NFC normalization and lowercasing so callers outside the
 * registration path (such as Relay Connect or trusted-sender gates comparing
 * untrusted or legacy names) share one deterministic canonical form. For valid
 * printable ASCII names this is identical to `name.toLowerCase()`.
 */
export function canonicalizeAgentName(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/**
 * Validate an agent name and return its canonical uniqueness key.
 *
 * Rejects empty names, names exceeding {@link AGENT_NAME_MAX_LENGTH}, control
 * characters, whitespace, invisible/zero-width/bidi characters, and non-ASCII
 * characters. Display casing is preserved by callers; `canonical` is used for
 * case-insensitive uniqueness checks.
 */
export function validateAgentName(name: string): AgentNameValidationResult {
  if (name.length === 0) {
    return { ok: false, reason: 'Agent name must not be empty' };
  }
  if (name.length > AGENT_NAME_MAX_LENGTH) {
    return {
      ok: false,
      reason: `Agent name must be at most ${AGENT_NAME_MAX_LENGTH} characters`,
    };
  }
  if (AGENT_NAME_CONTROL_CHARS.test(name)) {
    return { ok: false, reason: 'Agent name must not contain control characters' };
  }
  if (AGENT_NAME_WHITESPACE.test(name)) {
    return { ok: false, reason: 'Agent name must not contain whitespace' };
  }
  if (!AGENT_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      reason: 'Agent name must contain only printable ASCII characters (0x21-0x7E)',
    };
  }
  return { ok: true, canonical: canonicalizeAgentName(name) };
}
