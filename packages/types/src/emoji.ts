/** Common shortcode-to-emoji mappings used by agents. */
const SHORTCODE_TO_EMOJI: Record<string, string> = {
  thumbsup: '👍', thumbs_up: '👍', '+1': '👍',
  thumbsdown: '👎', thumbs_down: '👎', '-1': '👎',
  heart: '❤️', red_heart: '❤️',
  fire: '🔥', flame: '🔥',
  rocket: '🚀',
  check: '✅', white_check_mark: '✅', checkmark: '✅',
  x: '❌', cross_mark: '❌',
  eyes: '👀',
  clap: '👏', clapping: '👏',
  wave: '👋', waving: '👋',
  star: '⭐', star2: '🌟',
  100: '💯',
  tada: '🎉', party: '🎉',
  laugh: '😂', joy: '😂',
  smile: '😊', smiley: '😊',
  think: '🤔', thinking: '🤔', thinking_face: '🤔',
  pray: '🙏', thanks: '🙏',
  muscle: '💪', strong: '💪',
  bug: '🐛',
  wrench: '🔧', tool: '🔧',
  bulb: '💡', idea: '💡', lightbulb: '💡',
  warning: '⚠️',
  sparkles: '✨', sparkle: '✨',
  memo: '📝', note: '📝',
  lock: '🔒',
  gear: '⚙️', settings: '⚙️',
  hourglass: '⏳',
  zap: '⚡', lightning: '⚡',
};

/**
 * Resolve an emoji shortcode to its Unicode character.
 * If the input is already an emoji character, it is returned as-is.
 * Strips optional surrounding colons (e.g. `:thumbsup:` → `👍`).
 */
export function resolveEmoji(input: string): string {
  const trimmed = input.trim().replace(/^:|:$/g, '');
  return SHORTCODE_TO_EMOJI[trimmed.toLowerCase()] ?? input;
}
