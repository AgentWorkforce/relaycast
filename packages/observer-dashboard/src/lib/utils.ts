import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export interface DmParticipantLike {
  agentName: string;
}

export function formatDmLabel(
  participants: DmParticipantLike[],
  fallbackName?: string | null,
): string {
  const participantLabel = participants
    .map((participant) => participant.agentName.trim())
    .filter((name) => name.length > 0)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .join(', ');

  const normalizedFallback = fallbackName?.trim();
  return participantLabel || normalizedFallback || 'Direct Message';
}
