import { randomUUID } from 'node:crypto';
import type { CompiledAgentPermissions } from './compiler.js';

function normalizeRules(
  aclRules: Record<string, string[]>,
): Array<[string, string[]]> {
  return Object.entries(aclRules).map(([dir, rules]) => [
    dir,
    [...new Set(rules.map((rule) => rule.trim()).filter(Boolean))].sort(
      (left, right) => left.localeCompare(right),
    ),
  ]);
}

function toAclMarkerPath(dir: string): string {
  const normalized = dir && dir !== '/' ? dir.replace(/\/+$/, '') : '';
  return `${normalized}/.relayfile.acl` || '/.relayfile.acl';
}

export async function seedAgentPermissions(
  relayfileUrl: string,
  workspaceId: string,
  token: string,
  compiledPermissions: CompiledAgentPermissions[],
): Promise<void> {
  const mergedRules = new Map<string, Set<string>>();

  for (const compiled of compiledPermissions) {
    for (const [dir, rules] of normalizeRules(compiled.aclRules)) {
      const bucket = mergedRules.get(dir) ?? new Set<string>();
      for (const rule of rules) {
        bucket.add(rule);
      }
      mergedRules.set(dir, bucket);
    }
  }

  if (mergedRules.size === 0) {
    return;
  }

  const files = [...mergedRules.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([dir, rules]) => {
      const permissions = [...rules].sort((left, right) =>
        left.localeCompare(right),
      );
      return {
        path: toAclMarkerPath(dir),
        contentType: 'text/plain; charset=utf-8',
        content: permissions.join('\n'),
        semantics: {
          permissions,
        },
      };
    });

  const response = await fetch(
    `${relayfileUrl.replace(/\/+$/, '')}/v1/workspaces/${encodeURIComponent(
      workspaceId,
    )}/fs/bulk`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Correlation-Id': `corr_relayauth_relayfile_permissions_${randomUUID()}`,
      },
      body: JSON.stringify({
        workspaceId,
        files,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `relayfile ACL seed failed (${response.status} ${response.statusText})`,
    );
  }
}
