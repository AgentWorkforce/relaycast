const { workflow } = require('@agent-relay/sdk/workflows');

async function main() {
  const result = await workflow('consistent-brand-styling')
    .description(
      'Move @relaycast/brand package to the relay repo, update relay publish workflow, ' +
      'restyle relaycast site to match relay header/hero structure, add dark/light toggle, ' +
      '"Powered by Agent Relay" badge, and a messaging-focused hero animation.'
    )
    .pattern('dag')
    .channel('wf-consistent-brand-styling')
    .maxConcurrency(5)
    .timeout(3_600_000)

    // ── Agents ──────────────────────────────────────────────────────────────

    .agent('lead', {
      cli: 'claude',
      role: 'Lead architect — coordinates workers, reviews output, resolves conflicts.',
    })
    .agent('brand-mover', {
      cli: 'codex',
      preset: 'worker',
      role: 'Copies the brand package to the relay repo and removes it from relaycast.',
    })
    .agent('publish-updater', {
      cli: 'codex',
      preset: 'worker',
      role: 'Updates the relay publish.yml workflow to include the brand package.',
    })
    .agent('header-stylist', {
      cli: 'codex',
      preset: 'worker',
      role: 'Restyles the relaycast site header/nav to match relay\'s sticky rounded nav bar.',
    })
    .agent('hero-stylist', {
      cli: 'codex',
      preset: 'worker',
      role: 'Restructures the hero section to match relay\'s left/right grid layout with messaging animation.',
    })
    .agent('theme-dev', {
      cli: 'codex',
      preset: 'worker',
      role: 'Adds a dark/light mode toggle to the relaycast site.',
    })
    .agent('reviewer', {
      cli: 'claude',
      preset: 'reviewer',
      model: 'sonnet',
      role: 'Reviews the full diff for visual consistency and correctness.',
    })

    // ── Phase 1: Read all context (parallel, no deps) ───────────────────────

    .step('read-relaycast-brand-pkg', {
      type: 'deterministic',
      command: 'cat packages/brand/package.json',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-relaycast-brand-css', {
      type: 'deterministic',
      command: 'cat packages/brand/brand.css',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-relaycast-brand-readme', {
      type: 'deterministic',
      command: 'cat packages/brand/README.md',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-relaycast-brand-migration', {
      type: 'deterministic',
      command: 'cat packages/brand/RELAY_MIGRATION.md 2>/dev/null || echo "No migration doc"',
      captureOutput: true,
      failOnError: false,
    })
    .step('read-relay-publish', {
      type: 'deterministic',
      command: 'cat ../relay/.github/workflows/publish.yml',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-relay-nav', {
      type: 'deterministic',
      command: 'cat ../relay/web/components/SiteNav.tsx',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-relay-nav-css', {
      type: 'deterministic',
      command: 'cat ../relay/web/components/site-nav.module.css',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-relay-theme-toggle', {
      type: 'deterministic',
      command: 'cat ../relay/web/components/ThemeToggle.tsx && echo "---CSS---" && cat ../relay/web/components/theme-toggle.module.css',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-relay-hero', {
      type: 'deterministic',
      command: 'head -130 ../relay/web/app/page.tsx',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-relay-landing-css', {
      type: 'deterministic',
      command: 'head -200 ../relay/web/app/landing.module.css',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-relay-animation-css', {
      type: 'deterministic',
      command: 'cat ../relay/web/components/node-relay.module.css',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-relay-brand-css', {
      type: 'deterministic',
      command: 'cat ../relay/web/public/brand.css',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-current-html', {
      type: 'deterministic',
      command: 'cat site/index.html',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-current-css', {
      type: 'deterministic',
      command: 'cat site/styles.css',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-current-hero-js', {
      type: 'deterministic',
      command: 'cat site/hero-animation.js',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-relaycast-publish', {
      type: 'deterministic',
      command: 'cat .github/workflows/publish-npm.yml',
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 2a: Move brand package to relay ────────────────────────────────

    .step('copy-brand-to-relay', {
      agent: 'brand-mover',
      dependsOn: [
        'read-relaycast-brand-pkg',
        'read-relaycast-brand-css',
        'read-relaycast-brand-readme',
        'read-relaycast-brand-migration',
      ],
      task: `Copy the @relaycast/brand package from this repo to the relay repo at ../relay/packages/brand/.

IMPORTANT: Write ALL files to disk using your file-writing tools. Do NOT just output content.

## Files to create in ../relay/packages/brand/

1. ../relay/packages/brand/package.json:
{{steps.read-relaycast-brand-pkg.output}}

2. ../relay/packages/brand/brand.css:
{{steps.read-relaycast-brand-css.output}}

3. ../relay/packages/brand/README.md:
{{steps.read-relaycast-brand-readme.output}}

4. ../relay/packages/brand/RELAY_MIGRATION.md (if content exists):
{{steps.read-relaycast-brand-migration.output}}

## After creating files in relay:

Remove the brand package from the relaycast repo:
- Delete the entire packages/brand/ directory in THIS repo (the relaycast repo)

## Update relaycast's publish-npm.yml:

Remove "brand" from the package choice options and matrix in .github/workflows/publish-npm.yml since the package now lives in relay.`,
      verification: { type: 'file_exists', value: '../relay/packages/brand/brand.css' },
    })

    .step('update-relay-publish', {
      agent: 'publish-updater',
      dependsOn: ['read-relay-publish', 'copy-brand-to-relay'],
      task: `Update the relay repo's publish workflow to include the brand package.

IMPORTANT: Write the updated file to disk at ../relay/.github/workflows/publish.yml.

Current relay publish.yml:
{{steps.read-relay-publish.output}}

Changes needed:
1. Add "brand" to the package choice options (in the workflow_dispatch inputs, after "sdk-py")
2. The brand package has NO build step — it's pure CSS. So if there's a build matrix,
   brand should be excluded from build but included in publish.
3. Add a publish step/matrix entry for @relaycast/brand that:
   - cd packages/brand
   - npm publish --provenance --access public
4. If there's a release notes section, add @relaycast/brand to the package list.

Keep changes minimal — only add what's needed for brand publishing.`,
      verification: { type: 'exit_code' },
    })

    // ── Phase 2b: Restyle relaycast site (parallel with brand move) ──────────

    .step('restyle-header', {
      agent: 'header-stylist',
      dependsOn: [
        'read-relay-nav',
        'read-relay-nav-css',
        'read-relay-brand-css',
        'read-current-html',
        'read-current-css',
      ],
      task: `Restyle the relaycast site header/nav to match relay's design. Update BOTH site/index.html and site/styles.css.

IMPORTANT: Write updated files to disk. Do NOT just output code.

## Relay nav reference (SiteNav.tsx):
{{steps.read-relay-nav.output}}

## Relay nav CSS (site-nav.module.css):
{{steps.read-relay-nav-css.output}}

## Current relaycast HTML:
{{steps.read-current-html.output}}

## Current relaycast CSS:
{{steps.read-current-css.output}}

## Changes to site/index.html nav section:

1. RELAY LOGO — replace the diamond SVG icon with the Agent Relay logo SVG from SiteNav.tsx.
   The LogoIcon SVG (viewBox="0 0 112 91") has two paths — copy them exactly.
   Keep "relaycast" as the text label next to the logo.

2. NAV STRUCTURE — match relay's sticky rounded bar:
   - Wrap the nav in a container div (class="nav-outer") for sticky positioning
   - Nav bar should be a rounded container (border-radius: 14px) inside that outer div
   - Logo on left, links center/right, actions (theme toggle + GitHub) on right
   - Add a "Docs" and "Blog" link matching relay's nav

3. "POWERED BY AGENT RELAY" — add a badge in the header nav area (right side):
   <a href="https://agentrelay.dev" class="powered-by">
     Powered by <strong>Agent Relay</strong>
   </a>
   Style as small pill badge (font-size: 0.72rem, border: 1px solid var(--nav-border), border-radius: 6px, padding: 5px 12px)

4. MOBILE — add hamburger menu button (hidden on desktop, shown at 960px and below):
   - Hide nav links and actions on mobile
   - Show hamburger icon
   - Mobile menu dropdown with links + theme toggle

## Changes to site/styles.css nav section:

Match relay's nav CSS patterns:
- .nav-outer: position: sticky; top: 12px; z-index: 50; padding: 0 24px;
- .nav: max-width: 1280px; margin: 0 auto; background: var(--nav-solid-bg);
  border: 1px solid var(--nav-border); border-radius: 14px;
  box-shadow: 0 8px 24px var(--nav-shadow), inset 0 1px 0 var(--nav-inset);
- On scroll, add a class for blur effect:
  backdrop-filter: blur(24px) saturate(2) brightness(1.05);
- Logo icon: width: 34px; height: 28px; color: var(--nav-logo-mark)
- Links: font-size: 0.78rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
  border-bottom: 2.5px solid transparent on hover
- .powered-by pill: match relay's .agentLink styling
- Mobile breakpoint at 960px: hide links, show hamburger

DO NOT change any content below the nav (features, pricing, etc).
DO NOT remove PostHog or telemetry attributes.
Preserve all existing IDs and data attributes.`,
      verification: { type: 'exit_code' },
    })

    .step('restyle-hero', {
      agent: 'hero-stylist',
      dependsOn: [
        'read-relay-hero',
        'read-relay-landing-css',
        'read-relay-animation-css',
        'read-relay-brand-css',
        'read-current-html',
        'read-current-css',
        'read-current-hero-js',
      ],
      task: `Restructure the relaycast hero section to match relay's left/right grid layout,
and update the hero animation to emphasize messaging with floating messages.

IMPORTANT: Write updated files to disk. Do NOT just output code.

## Relay hero HTML structure (page.tsx):
{{steps.read-relay-hero.output}}

## Relay hero/landing CSS:
{{steps.read-relay-landing-css.output}}

## Relay animation card CSS:
{{steps.read-relay-animation-css.output}}

## Relay brand.css (color tokens):
{{steps.read-relay-brand-css.output}}

## Current relaycast HTML:
{{steps.read-current-html.output}}

## Current relaycast CSS:
{{steps.read-current-css.output}}

## Current hero animation JS:
{{steps.read-current-hero-js.output}}

## Changes to site/index.html hero section:

1. HERO LAYOUT — match relay's grid structure:
   - Wrap in a .hero-section div (like relay's .heroSection)
   - Add an SVG background layer (like relay's .heroBgSvg) but with MESSAGE-themed nodes:
     Instead of generic nodes, show envelope/message icons at the node positions.
     Use the same SVG structure (paths for connections, circles for nodes, ghost card outlines)
     but add small message indicators (tiny rectangles with speech-bubble shapes).
   - Inside, a .hero grid with two columns: .hero-left (text) and .hero-right (animation)
   - .hero-left contains: headline, subtitle, CTA buttons
   - .hero-right contains: the hero-animation canvas

2. HEADLINE — match relay's style:
   - Large clamp font: clamp(3.2rem, 7vw, 5.5rem)
   - Clean text, no gradient fill (just var(--fg) with opacity 0.85)
   - Keep relaycast's messaging-focused copy

3. CTA BUTTONS — match relay's button style:
   - Primary: pill shape (border-radius: 100px), var(--btn-bg) background, white text,
     box-shadow with brand color, hover translateY(-1px)
   - Secondary: pill shape, transparent bg, var(--line) border, hover border-color: var(--primary)

4. Keep the "Now in public beta" badge but style it like relay's .badge:
   - background: var(--bg-elevated); border: 1px solid var(--line);
   - border-radius: 100px; with a pulsing dot

## Changes to site/styles.css hero section:

Match relay's landing.module.css hero patterns:
- .hero-section: position: relative; overflow: hidden;
- .hero-bg-svg: position: absolute; inset: 0; pointer-events: none; opacity: 0.96;
- .hero: display: grid; grid-template-columns: 1fr 1.2fr; align-items: center;
  gap: 32px; max-width: 1280px; margin: 0 auto; padding: 20px 40px 32px;
- .hero-left: flex column, gap: 28px
- .hero-right: position: relative; min-height: 580px;
- .headline: font-size: clamp(3.2rem, 7vw, 5.5rem); font-weight: 500;
  line-height: 1.05; letter-spacing: -0.03em; opacity: 0.85;
- Dark mode override: :root[data-theme='dark'] .headline { opacity: 1; }
- Page background gradient matching relay:
  Light: radial-gradient(ellipse 36% 28% at 10% 8%, color-mix(in srgb, var(--primary) 16%, white 22%), transparent 72%), ...
  Dark: radial-gradient(circle at 14% 0%, color-mix(in srgb, var(--primary) 18%, transparent), transparent 36%), ...
- Responsive: at 960px, hero grid becomes single column

## Changes to site/hero-animation.js:

Keep the existing canvas-based animation but adjust it to EMPHASIZE MESSAGING more:
1. Add floating message bubbles that drift across the animation:
   - Small rounded rectangles with a speech-bubble tail
   - Semi-transparent, using var(--primary) with low opacity
   - Gentle floating motion (sinusoidal vertical drift + slow horizontal movement)
   - Messages appear, float for 3-5 seconds, then fade out
2. Add a few message "cards" that look like the relay agent cards but contain message previews:
   - Small rounded rect (160x88px) with header bar and status dot
   - Header shows channel name (#general, #dev)
   - Body shows a truncated message snippet
   - Cards positioned at fixed points, with subtle glow when "active"
3. Keep existing channel sidebar, message panel, and DM panel rendering
4. Keep existing particle system for message-in-flight trails

DO NOT change any content below the hero section.
DO NOT remove PostHog or telemetry attributes.`,
      verification: { type: 'exit_code' },
    })

    .step('add-theme-toggle', {
      agent: 'theme-dev',
      dependsOn: [
        'read-relay-theme-toggle',
        'read-relay-brand-css',
        'read-current-html',
        'read-current-css',
      ],
      task: `Add a dark/light mode toggle to the relaycast site, matching relay's ThemeToggle behavior.

IMPORTANT: Write updated files to disk. Do NOT just output code.

## Relay ThemeToggle reference:
{{steps.read-relay-theme-toggle.output}}

## Relay brand.css (has both light and dark tokens):
{{steps.read-relay-brand-css.output}}

## Current relaycast HTML:
{{steps.read-current-html.output}}

## Current relaycast CSS:
{{steps.read-current-css.output}}

## Changes needed:

### 1. Create site/theme-toggle.js (vanilla JS, no React):

Implement the same behavior as relay's ThemeToggle.tsx but in vanilla JS:
- STORAGE_KEY: 'relaycast-theme'
- readTheme(): check document.documentElement.dataset.theme, default to 'dark'
- applyTheme(theme): set data-theme attribute, style.colorScheme, and localStorage
- Create a button with sun/moon SVG icons (copy from relay's ThemeToggle)
- On click, toggle between light and dark
- On page load, read from localStorage and apply
- Export function: initThemeToggle(containerId)

The button should have class "theme-toggle" and match relay's styling:
- width: 38px; height: 38px; border-radius: 999px;
- border: 1px solid var(--nav-border);
- background: var(--nav-surface);
- color: var(--nav-fg);

SVG icon: width/height 16px, stroke: currentColor, strokeWidth: 1.8

### 2. Update site/index.html:

- Add a <div id="theme-toggle"></div> in the nav actions area (right side, before GitHub link)
- Add <script src="theme-toggle.js"></script> before </body>
- Add inline script to call initThemeToggle('theme-toggle')
- Add data-theme="dark" to the <html> tag as default

### 3. Update site/styles.css:

Ensure the CSS has BOTH light and dark token blocks:
- :root block should have light mode values (from brand.css :root)
- :root[data-theme='dark'] block should have dark mode values (from brand.css dark theme)
- Default to dark (add data-theme="dark" in HTML)

The light mode tokens (from brand.css):
--bg: #F9FAFB; --fg: #111827; --primary: var(--primary-500); --nav-solid-bg: #ffffff;
--nav-bg: rgba(255,255,255,0.76); --card-bg: rgba(255,255,255,0.9); etc.

The dark mode tokens (from brand.css):
--bg: #08111A; --fg: #EDF4FB; --primary: #74B8E2; --nav-solid-bg: #0c1c2a;
--nav-bg: rgba(12,28,42,0.92); --card-bg: rgba(15,27,41,0.84); etc.

### 4. Theme toggle button CSS:

.theme-toggle { ... } matching relay's theme-toggle.module.css:
- display: inline-flex; align-items: center; justify-content: center;
- width: 38px; height: 38px; border-radius: 999px;
- border: 1px solid var(--nav-border); background: var(--nav-surface);
- Hover: background: var(--nav-surface-hover); transform: translateY(-1px);
- .theme-toggle svg: width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8;

DO NOT change page content or remove telemetry attributes.`,
      verification: { type: 'file_exists', value: 'site/theme-toggle.js' },
    })

    // ── Phase 2c: Remove brand from relaycast publish ────────────────────────

    .step('update-relaycast-publish', {
      type: 'deterministic',
      dependsOn: ['copy-brand-to-relay', 'read-relaycast-publish'],
      command: [
        'echo "Checking if brand was removed from relaycast packages..."',
        'if [ -d "packages/brand" ]; then echo "WARN: packages/brand still exists — brand-mover may not have removed it"; fi',
        'echo "Checking publish-npm.yml for brand references..."',
        'grep -c "brand" .github/workflows/publish-npm.yml && echo "Brand still referenced in publish workflow" || echo "Brand already removed from publish workflow"',
      ].join('; '),
      captureOutput: true,
      failOnError: false,
    })

    // ── Phase 3: Verify and review ──────────────────────────────────────────

    .step('verify-relay-brand', {
      type: 'deterministic',
      dependsOn: ['copy-brand-to-relay', 'update-relay-publish'],
      command:
        'missing=0; ' +
        'for f in ../relay/packages/brand/package.json ../relay/packages/brand/brand.css ../relay/packages/brand/README.md; do ' +
        '  if [ ! -f "$f" ]; then echo "MISSING: $f"; missing=$((missing+1)); fi; ' +
        'done; ' +
        'if [ $missing -gt 0 ]; then echo "$missing files missing in relay"; exit 1; fi; ' +
        'echo "All brand package files present in relay repo"; ' +
        'echo "---"; cat ../relay/packages/brand/package.json',
      failOnError: true,
      captureOutput: true,
    })

    .step('verify-site-files', {
      type: 'deterministic',
      dependsOn: ['restyle-header', 'restyle-hero', 'add-theme-toggle'],
      command:
        'missing=0; ' +
        'for f in site/index.html site/styles.css site/hero-animation.js site/theme-toggle.js; do ' +
        '  if [ ! -f "$f" ]; then echo "MISSING: $f"; missing=$((missing+1)); fi; ' +
        'done; ' +
        'if [ $missing -gt 0 ]; then echo "$missing site files missing"; exit 1; fi; ' +
        'echo "All site files present"',
      failOnError: true,
      captureOutput: true,
    })

    .step('verify-consistency', {
      type: 'deterministic',
      dependsOn: ['verify-site-files'],
      command: [
        'echo "=== Relay logo in nav ==="',
        'grep -c "viewBox=\\"0 0 112 91\\"" site/index.html || echo "WARN: relay logo SVG missing"',
        'echo ""',
        'echo "=== Powered by Agent Relay ==="',
        'grep -c "Powered by" site/index.html || echo "WARN: powered-by badge missing"',
        'echo ""',
        'echo "=== Theme toggle ==="',
        'grep -c "theme-toggle" site/index.html || echo "WARN: theme toggle not wired"',
        'echo ""',
        'echo "=== Hero grid layout ==="',
        'grep -c "hero-left\\|hero-right\\|heroLeft\\|heroRight" site/index.html || echo "WARN: hero grid not found"',
        'echo ""',
        'echo "=== Dark mode tokens ==="',
        'grep -c "data-theme.*dark" site/styles.css || echo "WARN: dark mode block missing"',
        'echo ""',
        'echo "=== Light mode tokens ==="',
        'grep -c "#F9FAFB\\|#111827" site/styles.css || echo "WARN: light mode tokens missing"',
        'echo ""',
        'echo "=== Sticky nav ==="',
        'grep -c "nav-outer\\|navOuter\\|sticky" site/styles.css || echo "WARN: sticky nav missing"',
        'echo ""',
        'echo "=== Rounded nav bar ==="',
        'grep -c "border-radius.*14px\\|border-radius: 14" site/styles.css || echo "WARN: rounded nav missing"',
        'echo ""',
        'echo "=== Hero background SVG ==="',
        'grep -c "hero-bg-svg\\|heroBgSvg" site/index.html || echo "WARN: hero bg SVG missing"',
        'echo ""',
        'echo "=== Responsive breakpoints ==="',
        'grep -c "@media" site/styles.css',
        'echo ""',
        'echo "=== HTML sections intact ==="',
        'grep -c "<section" site/index.html',
      ].join('; '),
      captureOutput: true,
      failOnError: false,
    })

    .step('capture-diff', {
      type: 'deterministic',
      dependsOn: ['verify-consistency', 'verify-relay-brand'],
      command: [
        'echo "=== Relaycast repo changes ==="',
        'cd /Users/khaliqgant/Projects/AgentWorkforce/relaycast && git diff --stat',
        'echo ""',
        'echo "=== Relay repo changes ==="',
        'cd /Users/khaliqgant/Projects/AgentWorkforce/relay && git diff --stat',
        'echo ""',
        'echo "=== Relaycast site diff ==="',
        'cd /Users/khaliqgant/Projects/AgentWorkforce/relaycast && git diff site/',
        'echo ""',
        'echo "=== Relay brand package diff ==="',
        'cd /Users/khaliqgant/Projects/AgentWorkforce/relay && git diff packages/brand/ .github/workflows/publish.yml',
      ].join('; '),
      captureOutput: true,
      failOnError: false,
    })

    .step('review', {
      agent: 'reviewer',
      dependsOn: ['capture-diff', 'verify-consistency'],
      task: `Review the consistent brand styling changes across both repos.

Verification output:
{{steps.verify-consistency.output}}

Diff:
{{steps.capture-diff.output}}

Review checklist:

## Brand package migration (relay repo):
1. ../relay/packages/brand/ has package.json, brand.css, README.md
2. brand.css content is identical to what was in relaycast
3. relay's publish.yml includes brand in package options

## Relaycast site header:
4. Nav uses relay logo SVG (viewBox="0 0 112 91" with two paths)
5. Nav is sticky rounded bar (border-radius: 14px) matching relay's site-nav.module.css
6. "Powered by Agent Relay" badge present in nav
7. Mobile hamburger menu at 960px breakpoint
8. Links styled uppercase with border-bottom hover (matching relay)

## Hero section:
9. Grid layout: .hero-left (text) + .hero-right (animation) like relay
10. SVG background layer with message-themed nodes
11. Headline uses clamp(3.2rem, 7vw, 5.5rem) like relay
12. CTA buttons are pill-shaped (border-radius: 100px) like relay
13. Hero animation emphasizes messaging (floating messages, message cards)

## Theme toggle:
14. Dark/light toggle button present in nav
15. Toggle uses sun/moon SVG icons
16. CSS has both :root (light) and :root[data-theme='dark'] blocks
17. localStorage persistence with 'relaycast-theme' key
18. Default theme is dark

## General:
19. All responsive breakpoints preserved
20. PostHog and telemetry attributes intact
21. No broken HTML structure
22. hero-animation.js and theme-toggle.js both load correctly

If you find issues, list them with file:line references.`,
    })

    // ── Run ─────────────────────────────────────────────────────────────────

    .onError('fail-fast')
    .run({
      onEvent: (e) => console.log(`[${e.type}] ${e.step ?? ''}`),
    });

  console.log('Result:', result.status);
}

main().catch(console.error);
