const { workflow } = require('@agent-relay/sdk/workflows');

async function main() {
  const result = await workflow('site-brand-restyling')
    .description(
      'Create @relaycast/brand package from relay brand.css, update the publish ' +
      'workflow to include it, restyle the landing page (site/) to use the shared ' +
      'brand tokens, and ensure relay can migrate to @relaycast/brand without breakage.'
    )
    .pattern('dag')
    .channel('wf-site-brand-restyling')
    .maxConcurrency(4)
    .timeout(3600000)

    // ── Agents ──────────────────────────────────────────────────────────────

    .agent('package-creator', {
      cli: 'claude',
      preset: 'worker',
      model: 'sonnet',
      role: 'Creates the @relaycast/brand package and updates publish workflow.',
    })
    .agent('stylist', {
      cli: 'claude',
      preset: 'worker',
      model: 'sonnet',
      role: 'Rewrites site/styles.css to import @relaycast/brand and apply relay visual treatment.',
    })
    .agent('markup-updater', {
      cli: 'claude',
      preset: 'worker',
      model: 'sonnet',
      role: 'Updates site/index.html for the new light theme.',
    })
    .agent('relay-migrator', {
      cli: 'claude',
      preset: 'worker',
      model: 'sonnet',
      role: 'Creates a migration guide showing how relay can switch from local brand.css to @relaycast/brand.',
    })
    .agent('reviewer', {
      cli: 'claude',
      preset: 'reviewer',
      model: 'sonnet',
      role: 'Reviews the full diff for correctness, publish workflow changes, and relay compatibility.',
    })

    // ── Phase 1: Read all context (parallel, no deps) ───────────────────────

    .step('read-relay-brand', {
      type: 'deterministic',
      command: 'cat ../relay/web/public/brand.css',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-relay-globals', {
      type: 'deterministic',
      command: 'cat ../relay/web/app/globals.css',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-relay-landing-css', {
      type: 'deterministic',
      command: 'head -300 ../relay/web/app/landing.module.css',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-current-site-css', {
      type: 'deterministic',
      command: 'cat site/styles.css',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-current-site-html', {
      type: 'deterministic',
      command: 'cat site/index.html',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-publish-workflow', {
      type: 'deterministic',
      command: 'cat .github/workflows/publish-npm.yml',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-relay-publish-workflow', {
      type: 'deterministic',
      command: 'cat ../relay/.github/workflows/publish.yml',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-turbo-config', {
      type: 'deterministic',
      command: 'cat turbo.json 2>/dev/null || echo "{}"',
      captureOutput: true,
      failOnError: false,
    })

    // ── Phase 2: Create brand package + migration guide (parallel) ──────────

    .step('create-brand-package', {
      agent: 'package-creator',
      dependsOn: ['read-relay-brand', 'read-publish-workflow', 'read-turbo-config'],
      task: `Create a new @relaycast/brand package and update the publish workflow.

IMPORTANT: Write ALL files to disk using your file-writing tools.
Do NOT just output content to stdout.

## Step 1: Create packages/brand/

Create these files:

1. packages/brand/package.json:
   - name: "@relaycast/brand"
   - version: match other packages (read from packages/types/package.json)
   - description: "Shared brand tokens, CSS variables, and color system for Agent Relay / Relaycast"
   - main: "brand.css"
   - style: "brand.css"
   - files: ["brand.css", "README.md"]
   - No build step needed — this is a pure CSS package
   - exports: { ".": "./brand.css", "./brand.css": "./brand.css" }

2. packages/brand/brand.css:
   Copy the exact content of relay's brand.css:
   {{steps.read-relay-brand.output}}

3. packages/brand/README.md:
   Brief README explaining usage:
   - Import in CSS: @import '@relaycast/brand/brand.css';
   - Or link directly: <link rel="stylesheet" href="node_modules/@relaycast/brand/brand.css">
   - For static sites without a bundler: copy brand.css or use a CDN

## Step 2: Update .github/workflows/publish-npm.yml

Current workflow:
{{steps.read-publish-workflow.output}}

Changes needed:
1. Add "brand" to the package choice options (after "types", before "server")
2. Add "brand" to the matrix.package list in publish-packages job
3. Add @relaycast/brand to the release body install commands and packages table
4. The version sync script already handles all packages/ dirs — no change needed there

## Step 3: Update turbo.json if it exists

Current turbo config:
{{steps.read-turbo-config.output}}

If turbo.json exists and lists specific packages, add brand to the build pipeline.
Since brand has no build step, it just needs to be recognized. If turbo uses
a wildcard for packages, no change needed.`,
      verification: { type: 'file_exists', value: 'packages/brand/brand.css' },
    })

    .step('create-relay-migration', {
      agent: 'relay-migrator',
      dependsOn: ['read-relay-brand', 'read-relay-globals', 'read-relay-publish-workflow'],
      task: `Create a migration guide showing how the relay repo can switch from its
local brand.css to the shared @relaycast/brand package.

IMPORTANT: Write the file to disk at packages/brand/RELAY_MIGRATION.md.
Do NOT just output the content to stdout.

Current relay usage:

1. brand.css lives at: relay/web/public/brand.css
2. Imported in globals.css via: @import "../public/brand.css";
   Full globals.css:
   {{steps.read-relay-globals.output}}
3. Referenced in BrandShowcase.tsx as a downloadable link

The relay repo publish workflow (for context on their package structure):
{{steps.read-relay-publish-workflow.output}}

Write a migration guide (packages/brand/RELAY_MIGRATION.md) covering:

1. **Install step**: npm install @relaycast/brand
2. **globals.css change**: Replace @import "../public/brand.css" with
   @import '@relaycast/brand/brand.css';
3. **public/brand.css**: Can be deleted after migration (or kept as a
   generated copy for the /brand.css download link)
4. **BrandShowcase.tsx**: Update the download link to point to the npm package
5. **No breaking changes**: The CSS variable names are identical — only the
   import path changes. All existing styles continue to work.
6. **Version pinning**: relay should pin @relaycast/brand to an exact version
   to avoid surprise style changes
7. **Rollback**: If anything breaks, revert globals.css import to the local
   file — zero risk

Keep it concise and actionable.`,
      verification: { type: 'file_exists', value: 'packages/brand/RELAY_MIGRATION.md' },
    })

    // ── Phase 2b: Verify brand package + read for downstream ────────────────

    .step('verify-brand-package', {
      type: 'deterministic',
      dependsOn: ['create-brand-package'],
      command:
        'missing=0; ' +
        'for f in packages/brand/package.json packages/brand/brand.css packages/brand/README.md; do ' +
        '  if [ ! -f "$f" ]; then echo "MISSING: $f"; missing=$((missing+1)); fi; ' +
        'done; ' +
        'if [ $missing -gt 0 ]; then echo "$missing files missing"; exit 1; fi; ' +
        'echo "All brand package files present"; echo "---"; cat packages/brand/package.json',
      failOnError: true,
      captureOutput: true,
    })

    .step('read-brand-css', {
      type: 'deterministic',
      dependsOn: ['verify-brand-package'],
      command: 'cat packages/brand/brand.css',
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 3: Restyle site CSS + HTML (parallel) ─────────────────────────

    .step('restyle-css', {
      agent: 'stylist',
      dependsOn: ['read-brand-css', 'read-relay-landing-css', 'read-current-site-css'],
      task: `Rewrite site/styles.css to use the relay brand palette from @relaycast/brand.

IMPORTANT: Write the updated file to disk at site/styles.css.
Do NOT just output the CSS to stdout.

The brand CSS (from @relaycast/brand/brand.css):
{{steps.read-brand-css.output}}

Relay landing.module.css (style reference):
{{steps.read-relay-landing-css.output}}

Current site/styles.css:
{{steps.read-current-site-css.output}}

Key changes:
1. At the very top, add a comment noting the brand source:
   /* Brand tokens: @relaycast/brand — see packages/brand/brand.css */
2. Replace the :root block with the relay brand variables from brand.css.
   Copy the FULL :root block from brand.css (all color scales, semantic tokens).
3. Switch to light background (#F9FAFB) with dark text (#111827)
4. Primary accent: Curious Blue (#4A90C2) instead of indigo (#6366f1)
5. Update all CSS rules that used old vars:
   - var(--bg) stays var(--bg) but now resolves to #F9FAFB
   - var(--text) → var(--fg), var(--text-muted) → var(--fg-muted)
   - var(--bg-card) → var(--card-bg)
   - var(--border) → var(--line)
   - var(--accent) → var(--primary)
   - var(--accent-hover) → var(--primary-hover)
   - var(--accent-glow) → color-mix(in srgb, var(--primary) 10%, transparent)
   - var(--green) → var(--status-green)
6. Buttons: pill shape (border-radius: 100px), relay button styling
7. Cards: light bg with subtle blue-tinted borders
8. Code blocks: var(--code-bg) (#F3F4F6) bg with var(--code-fg) (#1F2937) text
9. Nav: light background with blur, not dark
10. Syntax highlighting: adapt to light theme
    - .c-comment: var(--fg-faint) or #9CA3AF
    - .c-kw: var(--primary-900) or #223E58
    - .c-fn: var(--primary-600) or #2D6A9C
    - .c-str: var(--secondary-500) or #C1674B
11. Hero gradient: var(--hero-gradient) from brand.css
12. Preserve ALL responsive breakpoints and media queries exactly
13. Preserve ALL animations and transitions
14. Preserve the layout structure (max-widths, paddings, grid columns)`,
      verification: { type: 'exit_code' },
    })

    .step('update-html', {
      agent: 'markup-updater',
      dependsOn: ['read-brand-css', 'read-current-site-html'],
      task: `Update site/index.html to work with the new light-theme CSS.

IMPORTANT: Write the updated file to disk at site/index.html.
Do NOT just output the HTML to stdout.

Brand CSS variables (for reference on what colors are available):
{{steps.read-brand-css.output}}

Current HTML:
{{steps.read-current-site-html.output}}

Changes needed:
1. Syntax highlighting colors are now handled in CSS — no class changes needed
2. Keep code-dot colors: #ff5f57, #febc2e, #28c840 (standard terminal dots)
3. Keep the diamond logo icon, color comes from CSS via var(--primary)
4. If there's a meta theme-color, update to #F9FAFB
5. Keep Google Fonts link for Inter (relay uses Inter too)
6. DO NOT change any text content, section structure, or functionality
7. DO NOT remove any data-telemetry-cta attributes
8. DO NOT change the PostHog meta tags
9. DO NOT add any new script tags or external dependencies`,
      verification: { type: 'exit_code' },
    })

    // ── Phase 4: Verify and review ──────────────────────────────────────────

    .step('verify-files-exist', {
      type: 'deterministic',
      dependsOn: ['restyle-css', 'update-html', 'create-relay-migration'],
      command:
        'missing=0; ' +
        'for f in site/styles.css site/index.html packages/brand/package.json packages/brand/brand.css packages/brand/README.md packages/brand/RELAY_MIGRATION.md; do ' +
        '  if [ ! -f "$f" ]; then echo "MISSING: $f"; missing=$((missing+1)); fi; ' +
        'done; ' +
        'if [ $missing -gt 0 ]; then echo "$missing files missing"; exit 1; fi; ' +
        'echo "All files present"',
      failOnError: true,
      captureOutput: true,
    })

    .step('verify-no-dark-remnants', {
      type: 'deterministic',
      dependsOn: ['verify-files-exist'],
      command: [
        'echo "=== Checking for stale dark theme colors in site/ ==="',
        'grep -n "#0a0a0f\\|#12121a\\|#1a1a26\\|#1e1e2e\\|#e4e4ef\\|#7a7a8e\\|#6366f1\\|#818cf8" site/styles.css site/index.html && echo "WARN: dark theme remnants found" || echo "OK: no dark theme remnants"',
        'echo ""',
        'echo "=== Checking relay brand colors are present ==="',
        'grep -c "#F9FAFB\\|#111827\\|#4A90C2\\|#4B5563" site/styles.css || echo "WARN: relay brand colors missing"',
        'echo ""',
        'echo "=== Checking responsive breakpoints preserved ==="',
        'grep -c "@media" site/styles.css',
        'echo ""',
        'echo "=== Checking HTML sections intact ==="',
        'grep -c "<section" site/index.html',
        'echo ""',
        'echo "=== Checking publish workflow includes brand ==="',
        'grep -c "brand" .github/workflows/publish-npm.yml || echo "WARN: brand not in publish workflow"',
        'echo ""',
        'echo "=== Checking brand package.json is valid JSON ==="',
        "node -e \"JSON.parse(require('fs').readFileSync('packages/brand/package.json','utf8')); console.log('OK: valid JSON')\" || echo \"WARN: invalid package.json\"",
      ].join('; '),
      captureOutput: true,
      failOnError: false,
    })

    .step('capture-diff', {
      type: 'deterministic',
      dependsOn: ['verify-no-dark-remnants'],
      command: 'git diff --stat && echo "---FULL DIFF---" && git diff site/ packages/brand/ .github/workflows/publish-npm.yml',
      captureOutput: true,
      failOnError: false,
    })

    .step('review', {
      agent: 'reviewer',
      dependsOn: ['capture-diff', 'verify-no-dark-remnants'],
      task: `Review the brand package creation, site restyling, and publish workflow update.

Verification output:
{{steps.verify-no-dark-remnants.output}}

Diff:
{{steps.capture-diff.output}}

Review checklist:

Brand package:
1. packages/brand/package.json has correct name (@relaycast/brand), exports, and files
2. packages/brand/brand.css is identical to relay's brand.css (no modifications)
3. packages/brand/README.md explains usage clearly

Publish workflow:
4. "brand" added to package choice options
5. "brand" added to matrix.package list
6. @relaycast/brand in release body

Site restyling:
7. No dark theme color remnants (#0a0a0f, #12121a, #6366f1, etc.)
8. Relay brand colors present (#F9FAFB, #4A90C2, #111827, etc.)
9. All responsive breakpoints preserved (480px, 768px, 1024px)
10. All animations preserved (fadeUp, transitions)
11. Code blocks readable on light background
12. No content or structural HTML changes
13. PostHog and telemetry attributes intact

Relay compatibility:
14. brand.css variable names unchanged — relay can import without breakage
15. Migration guide is clear and actionable

If you find issues, list them clearly with file:line references.`,
    })

    .step('cleanup', {
      type: 'deterministic',
      dependsOn: ['review'],
      command: 'rm -f site/BRAND_MAPPING.md',
      failOnError: false,
    })

    // ── Run ─────────────────────────────────────────────────────────────────

    .onError('fail-fast')
    .run({
      onEvent: (e) => console.log(`[${e.type}] ${e.step ?? ''}`),
    });

  console.log('Result:', result.status);
}

main().catch(console.error);
