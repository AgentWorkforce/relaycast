export type ConversationalCandidate = {
  deployedName: string;
  channels?: readonly string[] | null;
  defaultResponder?: boolean;
  identity?: {
    username?: string;
    iconUrl?: string;
  };
};

export type SlackConversationalEvent = {
  channel: string;
  threadTs?: string;
  text: string;
};

export type SelectConversationalAgentInput = {
  candidates: ConversationalCandidate[];
  event: SlackConversationalEvent;
  threadOwner?: string | null;
};

export type SelectConversationalAgentResult =
  | {
      kind: "selected";
      agent: ConversationalCandidate;
      via: "thread" | "prefix" | "channel" | "default";
    }
  | {
      kind: "ambiguous";
      candidates: ConversationalCandidate[];
    }
  | {
      kind: "none";
    };

export function selectConversationalAgent(
  input: SelectConversationalAgentInput,
): SelectConversationalAgentResult {
  if (input.candidates.length === 0) {
    return { kind: "none" };
  }

  const threadMatches = matchesByDeployedName(input.candidates, input.threadOwner);
  if (threadMatches.length === 1) {
    return { kind: "selected", agent: threadMatches[0], via: "thread" };
  }
  if (threadMatches.length > 1) {
    return { kind: "ambiguous", candidates: threadMatches };
  }

  const prefixMatches = matchesByDeployedName(
    input.candidates,
    prefixTargetFromMention(input.event.text),
  );
  if (prefixMatches.length === 1) {
    return { kind: "selected", agent: prefixMatches[0], via: "prefix" };
  }
  if (prefixMatches.length > 1) {
    return { kind: "ambiguous", candidates: prefixMatches };
  }

  const channelMatches = input.candidates.filter((candidate) =>
    candidate.channels?.some((channel) => channel === input.event.channel),
  );
  if (channelMatches.length === 1) {
    return { kind: "selected", agent: channelMatches[0], via: "channel" };
  }
  if (channelMatches.length > 1) {
    return { kind: "ambiguous", candidates: channelMatches };
  }

  const defaultMatches = input.candidates.filter((candidate) => candidate.defaultResponder === true);
  if (defaultMatches.length === 1) {
    return { kind: "selected", agent: defaultMatches[0], via: "default" };
  }
  if (defaultMatches.length > 1) {
    return { kind: "ambiguous", candidates: defaultMatches };
  }

  return { kind: "none" };
}

function matchesByDeployedName(
  candidates: readonly ConversationalCandidate[],
  target: string | null | undefined,
): ConversationalCandidate[] {
  const normalizedTarget = normalizeAgentName(target);
  if (!normalizedTarget) {
    return [];
  }
  return candidates.filter((candidate) => normalizeAgentName(candidate.deployedName) === normalizedTarget);
}

function normalizeAgentName(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function prefixTargetFromMention(text: string): string | null {
  const withoutMention = text.replace(/^\s*<@[^>\s]+>\s*/u, "").trim();
  if (!withoutMention) {
    return null;
  }
  const [firstToken = ""] = withoutMention.split(/\s+/u, 1);
  const normalized = firstToken.replace(/:$/u, "").trim();
  return normalized.length > 0 ? normalized : null;
}
