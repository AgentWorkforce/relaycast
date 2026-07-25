#!/usr/bin/env node
/**
 * Cut the curated `[Unreleased]` block of every lockstep changelog into a
 * released heading, then restore a bare `[Unreleased]`.
 *
 * Curated entries are authoritative (see AGENTS.md "Changelog"). Commit
 * subjects are only a fallback for the root changelog when its pending block
 * is empty; a package changelog with nothing pending is left untouched, so the
 * release simply gets no heading there.
 *
 * Usage:
 *   node scripts/cut-changelog.mjs --version 6.3.0
 *                                 [--date 2026-07-25] [--from-tag v6.2.0]
 *                                 [--dry-run]
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

function flag(name) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

const version = flag('version');
if (!version || !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
  console.error('usage: cut-changelog.mjs --version <x.y.z> [--date <yyyy-mm-dd>] [--from-tag <tag>] [--dry-run]');
  process.exit(1);
}

// Prereleases publish off the same bump but do not close a release line, so the
// pending entries stay pending until the stable version ships.
if (version.includes('-')) {
  console.log(`prerelease v${version}: leaving [Unreleased] in place`);
  process.exit(0);
}

const date = flag('date') ?? new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error(`invalid --date: ${date}`);
  process.exit(1);
}

// The Rust SDK is published to crates.io on its own version line, so an npm
// release never closes its pending block. Every other package changelog is
// versioned in lockstep with the npm packages (the Swift SDK ships off the
// repo's release tag), including ones added later.
const EXCLUDED_PACKAGES = new Set(['sdk-rust']);

const UNRELEASED = /^## \[Unreleased(?: - (?:Patch|Minor|Major))?\][ \t]*\n([\s\S]*?)(?=^## \[|(?![\s\S]))/m;

const SECTION_BY_TYPE = new Map([
  ['feat', 'Added'],
  ['fix', 'Fixed'],
  ['perf', 'Changed'],
  ['revert', 'Changed'],
  ['deprecate', 'Deprecated'],
  ['deprecated', 'Deprecated'],
  ['remove', 'Removed'],
  ['removed', 'Removed'],
  ['security', 'Security'],
]);

const SECTION_ORDER = [
  'Breaking Changes',
  'Added',
  'Changed',
  'Deprecated',
  'Removed',
  'Fixed',
  'Security',
];

function warn(message) {
  console.warn(process.env.GITHUB_ACTIONS ? `::warning::${message}` : `warning: ${message}`);
}

function git(command) {
  return execSync(command, { encoding: 'utf-8' }).trim();
}

function lastStableTag() {
  const explicit = flag('from-tag');
  if (explicit) return explicit;
  const tags = git('git tag -l --sort=-v:refname')
    .split('\n')
    .map(tag => tag.trim())
    .filter(tag => /^v\d+\.\d+\.\d+$/.test(tag));
  return tags[0];
}

function levelOf(fromVersion, toVersion) {
  const from = fromVersion.split('.').map(Number);
  const to = toVersion.split('.').map(Number);
  if (to[0] !== from[0]) return 'Major';
  if (to[1] !== from[1]) return 'Minor';
  return 'Patch';
}

/** Commit subjects since `fromTag`, grouped into Keep a Changelog sections. */
function fallbackBody(fromTag) {
  if (!fromTag) return '';
  const subjects = git(`git log ${fromTag}..HEAD --no-merges --pretty=format:%s`)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  const sections = new Map(SECTION_ORDER.map(section => [section, []]));

  for (const subject of subjects) {
    const parsed = subject.match(/^([a-z]+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/i);
    if (!parsed) continue;
    const [, typeRaw, scope = '', bang, titleRaw] = parsed;
    const type = typeRaw.toLowerCase();
    if (type === 'chore' && scope.toLowerCase() === 'release') continue;

    const section = bang ? 'Breaking Changes' : SECTION_BY_TYPE.get(type);
    // Everything else (chore/docs/ci/test/build/style/refactor) is not part of
    // the release narrative.
    if (!section) continue;

    const title = titleRaw
      .replace(/\s*\(#\d+[^)]*\)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!title) continue;

    const entry = `${title.charAt(0).toUpperCase()}${title.slice(1)}`;
    const entries = sections.get(section);
    if (!entries.includes(entry)) entries.push(entry);
  }

  const lines = [];
  for (const section of SECTION_ORDER) {
    const entries = sections.get(section);
    if (entries.length === 0) continue;
    lines.push(`### ${section}`, '');
    for (const entry of entries) lines.push(`- ${entry}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * Replace the pending block in `file` with a released heading.
 * @returns the pending release level when the file was cut, otherwise null.
 */
function cut(file, { fallback = '' } = {}) {
  const changelog = readFileSync(file, 'utf-8');
  const match = changelog.match(UNRELEASED);
  if (!match) {
    warn(`${file}: no [Unreleased] heading, skipped`);
    return null;
  }

  const curated = match[1].trim();
  const body = curated || fallback;
  if (!body) {
    console.log(`${file}: nothing pending, left unchanged`);
    return null;
  }

  const start = match.index;
  const end = start + match[0].length;
  const updated =
    changelog.slice(0, start) +
    `## [Unreleased]\n\n## [${version}] - ${date}\n\n${body}\n\n` +
    changelog.slice(end);

  if (!dryRun) writeFileSync(file, updated);
  console.log(`${file}: cut [${version}] (${curated ? 'curated' : 'from commit subjects'})`);
  return match[0].match(/\[Unreleased - (Patch|Minor|Major)\]/)?.[1] ?? null;
}

const fromTag = lastStableTag();
if (!fromTag) warn('no previous stable tag found; commit-subject fallback disabled');
else console.log(`cutting v${version} (${date}), pending since ${fromTag}`);

const packageChangelogs = readdirSync('packages', { withFileTypes: true })
  .filter(entry => entry.isDirectory() && !EXCLUDED_PACKAGES.has(entry.name))
  .map(entry => path.join('packages', entry.name, 'CHANGELOG.md'))
  .filter(existsSync)
  .sort();

const levels = [];
for (const file of ['CHANGELOG.md', ...packageChangelogs]) {
  const level = cut(file, { fallback: file === 'CHANGELOG.md' ? fallbackBody(fromTag) : '' });
  if (level) levels.push({ file, level });
}

// The pending heading records the SemVer impact of what is being released; a
// release smaller than that impact is a mis-bump worth surfacing (after the
// fact — this runs post-publish, so it never fails the release).
if (fromTag) {
  const actual = levelOf(fromTag.replace(/^v/, ''), version);
  const rank = { Patch: 0, Minor: 1, Major: 2 };
  for (const { file, level } of levels) {
    if (rank[level] > rank[actual]) {
      warn(`${file} pending entries are marked ${level} but v${version} is a ${actual} bump`);
    }
  }
}

if (dryRun) console.log('dry run: no files written');
