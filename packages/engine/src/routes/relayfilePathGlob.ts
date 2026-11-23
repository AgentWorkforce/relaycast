/**
 * Match the RelayFile webhook contract from relayfile-cloud ba817966, including
 * its legacy trailing-prefix rules. Matching normalization follows core 0.10.34;
 * this helper never changes the target text used to derive an HMAC secret.
 * Keep legacy root /* matching and treat pattern stars as wildcard tokens even
 * when event paths contain literal stars, correcting two upstream edge cases.
 * Reference: https://github.com/AgentWorkforce/relayfile-cloud/blob/ba8179660deac4cf251754859ccd3d5ac2948b4f/packages/relayfile/src/webhook-delivery.ts
 */
export function eventMatchesRelayfileGlob(path: string, glob: string): boolean {
  const normalizedPath = normalizeMatchPath(path);
  const trimmed = glob.trim();
  const normalizedGlob = !trimmed || trimmed === '*' ? '/**' : normalizeMatchPath(trimmed);
  if (normalizedGlob === '/**' || normalizedGlob === normalizedPath) return true;
  const firstWildcard = normalizedGlob.indexOf('*');
  if (firstWildcard !== -1 && ![normalizedGlob.length - 1, normalizedGlob.length - 2].includes(firstWildcard)) {
    return webhookPathSegmentsMatch(normalizedPath, normalizedGlob);
  }
  if (normalizedGlob.endsWith('/**')) {
    const prefix = normalizeMatchPath(normalizedGlob.slice(0, -'/**'.length));
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
  }
  if (normalizedGlob.endsWith('/*')) {
    // The glob is already canonical. Keep the root prefix empty, not '/',
    // so legacy /* targets match root files without requiring a double slash.
    const prefix = normalizedGlob.slice(0, -'/*'.length);
    const suffix = normalizedPath.slice(prefix.length);
    return normalizedPath.startsWith(`${prefix}/`) && !suffix.slice(1).includes('/');
  }
  if (normalizedGlob.endsWith('*')) return normalizedPath.startsWith(normalizedGlob.slice(0, -1));
  return webhookPathSegmentsMatch(normalizedPath, normalizedGlob);
}

/** Canonicalize only for matching; preserve case, percent escapes and literal punctuation. */
function normalizeMatchPath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.trim().split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return '/' + segments.join('/');
}

/** Match stars inside one segment without compiling caller-controlled regexes. */
function wildcardSegmentMatches(path: string, pattern: string): boolean {
  let at = 0, patternAt = 0, star = -1, retry = 0;
  while (at < path.length) {
    if (patternAt < pattern.length && pattern[patternAt] !== '*' && pattern[patternAt] === path[at]) {
      at++;
      patternAt++;
    } else if (pattern[patternAt] === '*') {
      star = patternAt++;
      retry = at;
    } else if (star >= 0) {
      patternAt = star + 1;
      at = ++retry;
    } else return false;
  }
  while (pattern[patternAt] === '*') patternAt++;
  return patternAt === pattern.length;
}

/** Iterative dynamic programming bounds repeated ** patterns without recursive backtracking. */
function webhookPathSegmentsMatch(path: string, glob: string): boolean {
  const paths = path.split('/').filter(Boolean);
  let reachable = [true, ...paths.map(() => false)];
  for (const segment of glob.split('/').filter(Boolean)) {
    if (segment === '**') {
      for (let index = 1; index <= paths.length; index++) reachable[index] ||= reachable[index - 1];
    } else {
      reachable = [false, ...paths.map((part, index) => reachable[index] && wildcardSegmentMatches(part, segment))];
    }
  }
  return reachable[paths.length];
}
