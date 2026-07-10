/**
 * 063-github-via-relayfile.ts
 *
 * Wire cloud's GitHub integration to use relayfile as the data layer.
 *
 * Old approach (PR #41): cloud web app → Nango proxy → GitHub API directly
 * New approach: GitHub webhook → Nango → adapter-github → relayfile VFS → cloud reads VFS
 *
 * Cloud never talks to GitHub directly. It reads from relayfile VFS paths:
 *   /github/repos/{owner}/{repo}/pulls/{number}/metadata.json
 *   /github/repos/{owner}/{repo}/pulls/{number}/diff.patch
 *   /github/repos/{owner}/{repo}/pulls/{number}/reviews/*.json
 *   /github/repos/{owner}/{repo}/issues/{number}/metadata.json
 *
 * What this workflow builds:
 * 1. Integration connect flow (Nango OAuth — keep this, it's auth)
 * 2. Webhook receiver that forwards to relayfile adapter-github
 * 3. Dashboard that reads PR/issue data from relayfile VFS
 * 4. Relayfile client setup in cloud (workspace, token)
 *
 * Run: npx tsx workflows/063-github-via-relayfile.ts
 */

import { workflow } from '@relayflows/core';

const CLOUD = '/Users/khaliqgant/Projects/AgentWorkforce/cloud';
const ADAPTER_GH = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile-adapter-github';
const PROVIDER_NANGO = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile-provider-nango';

async function main() {
  const result = await workflow('github-via-relayfile')
    .description('Wire cloud GitHub integration through relayfile VFS instead of direct API calls')
    .pattern('linear')
    .channel('wf-cloud-github-relayfile')
    .maxConcurrency(2)
    .timeout(2_400_000)

    .agent('architect', { cli: 'claude', role: 'Designs the relayfile-backed GitHub integration' })
    .agent('builder', { cli: 'codex', preset: 'worker', role: 'Implements the integration' })
    .agent('reviewer', { cli: 'claude', role: 'Reviews the integration' })

    .step('design', {
      agent: 'architect',
      task: `Design how cloud's GitHub integration reads data from relayfile VFS.

READ the adapter-github to understand VFS paths:
- ${ADAPTER_GH}/src/types.ts
- ${ADAPTER_GH}/github.mapping.yaml (if exists)
- ${ADAPTER_GH}/src/path-mapper.ts (if exists)

READ the Nango provider to understand auth flow:
- ${PROVIDER_NANGO}/src/provider.ts

READ cloud's existing structure:
- ${CLOUD}/packages/web/ — Next.js web app
- ${CLOUD}/packages/relayfile/ — relayfile Cloudflare package (VFS access)
- ${CLOUD}/packages/relayauth/ — auth package

The integration has 3 parts:

**Part 1: OAuth Connect (keep from PR #41 pattern)**
- User clicks "Connect GitHub" on dashboard
- Cloud opens Nango OAuth flow (Nango frontend SDK)
- On success, Nango stores the GitHub App installation token
- Cloud stores the Nango connectionId in workspace_integrations table
- This part talks to Nango directly — it's auth, not data

**Part 2: Webhook → Relayfile Pipeline**
- GitHub sends webhooks to cloud's /api/v1/webhooks/github endpoint
- Cloud forwards raw webhook to relayfile adapter-github for normalization
- Adapter returns: VFS path + normalized payload
- Cloud writes the data to relayfile VFS at that path
- This replaces: cloud parsing GitHub webhooks and storing in its own DB

**Part 3: Dashboard reads from VFS**
- /integrations/github page shows PRs, issues, repos
- Instead of: cloud → Nango proxy → GitHub API → render
- Now: cloud → relayfile VFS → read files at /github/repos/... → render
- PR list: list files at /github/repos/{owner}/{repo}/pulls/
- PR detail: read /github/repos/{owner}/{repo}/pulls/{number}/metadata.json
- This is just RelayFileClient.listFiles() and .getFile()

Design the file structure, API routes, and data flow. Keep under 60 lines.
End with DESIGN_COMPLETE.`,
      verification: { type: 'output_contains', value: 'DESIGN_COMPLETE' },
      timeout: 300_000,
    })

    .step('implement', {
      agent: 'builder',
      dependsOn: ['design'],
      task: `Implement the relayfile-backed GitHub integration in cloud.

Design: {{steps.design.output}}

Working in ${CLOUD} on branch feat/github-via-relayfile.

1. Create/update packages/web/lib/integrations/nango-service.ts
   - Keep OAuth connect/disconnect flow
   - Remove any direct GitHub API proxy calls
   
2. Create packages/web/lib/integrations/github-relayfile.ts
   - Uses RelayFileClient to read GitHub data from VFS
   - listPullRequests(owner, repo) → list files at /github/repos/{owner}/{repo}/pulls/
   - getPullRequest(owner, repo, number) → read metadata.json
   - listIssues(owner, repo) → list files at /github/repos/{owner}/{repo}/issues/
   - getReviews(owner, repo, prNumber) → list files in reviews/

3. Update packages/web/app/api/v1/webhooks/github/route.ts
   - Receive raw GitHub webhook
   - Import adapter-github's normalizeWebhook + computePath
   - Write normalized data to relayfile VFS
   - No direct DB writes for GitHub data

4. Update dashboard pages to read from relayfile:
   - packages/web/app/integrations/github/page.tsx
   - Use github-relayfile.ts functions instead of Nango proxy

5. Migration: workspace_integrations table can stay (stores connectionId)
   But GitHub-specific data (PRs, issues) comes from relayfile, not local DB

6. Tests, build check
7. Commit + push to feat/github-via-relayfile

End with IMPLEMENT_COMPLETE.`,
      verification: { type: 'output_contains', value: 'IMPLEMENT_COMPLETE' },
      timeout: 900_000,
    })

    .step('review', {
      agent: 'reviewer',
      dependsOn: ['implement'],
      task: `Review the GitHub-via-relayfile integration in ${CLOUD}.
Verify:
- Cloud NEVER calls GitHub API directly for data (only Nango for OAuth)
- All GitHub data reads go through RelayFileClient
- Webhook handler normalizes via adapter-github, writes to VFS
- Dashboard renders data from VFS reads
- No GitHub tokens stored in cloud (Nango owns them)
Fix issues. Keep under 40 lines. End with REVIEW_COMPLETE.`,
      verification: { type: 'output_contains', value: 'REVIEW_COMPLETE' },
      timeout: 300_000,
    })

    .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
    .run({ cwd: CLOUD });

  console.log('GitHub via relayfile complete:', result.status);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
