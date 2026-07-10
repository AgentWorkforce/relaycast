const SUPPORTED_MESSAGE_SUBTYPES = new Set(['bot_message']);

export function isSupportedSlackMessageSubtype(subtype: string | undefined): boolean {
    return !subtype || SUPPORTED_MESSAGE_SUBTYPES.has(subtype);
}
