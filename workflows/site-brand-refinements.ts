const { workflow } = require('@agent-relay/sdk/workflows');

async function main() {
  const result = await workflow('site-brand-refinements')
    .description(
      'Refine the relaycast landing page: dark mode default, relay logo, ' +
      '"powered by Agent Relay" badge, message-focused animation, and gradient background.'
    )
    .pattern('dag')
    .channel('wf-site-brand-refinements')
    .maxConcurrency(4)
    .timeout(3600000)

    .agent('stylist', {
      cli: 'claude',
      preset: 'worker',
      model: 'sonnet',
      role: 'Updates site/styles.css for dark mode default, gradient background, and relay visual treatment.',
    })
    .agent('markup-dev', {
      cli: 'claude',
      preset: 'worker',
      model: 'sonnet',
      role: 'Updates site/index.html with relay logo, powered-by badge, and message animation.',
    })
    .agent('animation-dev', {
      cli: 'claude',
      preset: 'worker',
      model: 'sonnet',
      role: 'Creates a messaging-focused SVG animation for the hero section.',
    })
    .agent('reviewer', {
      cli: 'claude',
      preset: 'reviewer',
      model: 'sonnet',
      role: 'Reviews the full diff for visual consistency and responsive behavior.',
    })

    // ── Phase 1: Read context ───────────────────────────────────────────

    .step('read-relay-brand', {
      type: 'deterministic',
      command: 'cat ../relay/web/public/brand.css',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-relay-nav', {
      type: 'deterministic',
      command: 'cat ../relay/web/components/SiteNav.tsx',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-relay-animation', {
      type: 'deterministic',
      command: 'cat ../relay/web/components/NodeRelayAnimation.tsx',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-relay-landing-css', {
      type: 'deterministic',
      command: 'cat ../relay/web/app/landing.module.css',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-relay-page', {
      type: 'deterministic',
      command: 'head -130 ../relay/web/app/page.tsx',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-current-css', {
      type: 'deterministic',
      command: 'cat site/styles.css',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-current-html', {
      type: 'deterministic',
      command: 'cat site/index.html',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-current-js', {
      type: 'deterministic',
      command: 'cat site/script.js',
      captureOutput: true,
      failOnError: false,
    })

    // ── Phase 2: Create animation + restyle CSS + update HTML (parallel) ─

    .step('create-animation', {
      agent: 'animation-dev',
      dependsOn: ['read-relay-animation', 'read-relay-landing-css', 'read-relay-page'],
      task: `Create a messaging-focused SVG/CSS animation for the relaycast hero section.
Write it to site/hero-animation.js (vanilla JS, no framework).

IMPORTANT: Write the file to disk. Do NOT just output code to stdout.

Reference the relay animation for style:
{{steps.read-relay-animation.output}}

Relay hero section structure:
{{steps.read-relay-page.output}}

The relay animation shows nodes relaying between agents. The relaycast animation
should focus on the MESSAGING aspect — show:
1. Message bubbles flowing between agent nodes
2. Channel indicators (#general, #dev) with messages routing to them
3. DM arrows between specific agent pairs
4. Subtle pulse/glow effects on active channels
5. Thread reply indicators branching off messages

Technical requirements:
- Pure vanilla JS + inline SVG (no React, no dependencies)
- Animate with CSS animations and requestAnimationFrame
- Responsive — scale with container
- Use CSS variables from brand.css (var(--primary), var(--fg), etc.)
- Dark theme colors (the page defaults to dark mode)
- Export a function: initHeroAnimation(containerId)
- Smooth, subtle, professional — not flashy
- Messages should appear to flow, not teleport`,
      verification: { type: 'file_exists', value: 'site/hero-animation.js' },
    })

    .step('restyle-css', {
      agent: 'stylist',
      dependsOn: ['read-relay-brand', 'read-relay-landing-css', 'read-current-css'],
      task: `Update site/styles.css to default to dark mode with relay's gradient background.

IMPORTANT: Write the updated file to disk at site/styles.css.
Do NOT just output the CSS to stdout.

Relay brand.css (has both light and dark tokens):
{{steps.read-relay-brand.output}}

Relay landing CSS (gradient and visual treatment reference):
{{steps.read-relay-landing-css.output}}

Current site/styles.css:
{{steps.read-current-css.output}}

Changes needed:

1. DEFAULT TO DARK MODE — the :root block should use dark theme values:
   - --bg: #0F1117 (dark background, similar to relay's dark mode)
   - --fg: #E5E7EB (light text)
   - --fg-muted: #9CA3AF
   - --bg-elevated: rgba(255,255,255,0.04)
   - --card-bg: rgba(255,255,255,0.03)
   - --line: rgba(74,144,194,0.12)
   - --surface: #1A1D27
   - --code-bg: #1A1D27
   - --code-fg: #C9D1D9
   Keep the primary scale (Curious Blue #4A90C2) and secondary (warm #C1674B)
   from brand.css — those work in both themes.

2. HERO GRADIENT BACKGROUND — match relay's style:
   - --hero-gradient: linear-gradient(180deg, #0F1117 0%, color-mix(in srgb, var(--primary) 8%, #0F1117) 100%)
   - Add a subtle radial glow behind the hero:
     background: var(--hero-gradient);
     position: relative with a ::after pseudo-element for radial accent glow

3. NAV — dark blur background:
   background: rgba(15, 17, 23, 0.85);
   backdrop-filter: blur(16px);

4. BUTTONS — keep pill shape, adjust for dark:
   - Primary: var(--primary) bg, white text
   - Ghost: transparent with light border

5. CARDS — dark surface with subtle blue-tinted borders:
   background: var(--card-bg)
   border: 1px solid var(--line)

6. CODE BLOCKS — dark terminal style:
   background: var(--code-bg)
   color: var(--code-fg)

7. SYNTAX HIGHLIGHTING for dark mode:
   - .c-comment: #555 or var(--fg-faint)
   - .c-kw: #7EB8DA (console keyword blue)
   - .c-fn: #4EC9B0 (console type green)
   - .c-str: #CE9178 (console string orange)

8. Add hero animation container styles:
   .hero-animation { position: absolute; inset: 0; z-index: 0; pointer-events: none; overflow: hidden; }

9. Preserve ALL responsive breakpoints and media queries
10. Preserve ALL animations`,
      verification: { type: 'exit_code' },
    })

    .step('read-animation', {
      type: 'deterministic',
      dependsOn: ['create-animation'],
      command: 'cat site/hero-animation.js',
      captureOutput: true,
      failOnError: true,
    })

    .step('update-html', {
      agent: 'markup-dev',
      dependsOn: ['read-relay-nav', 'read-current-html', 'read-animation'],
      task: `Update site/index.html with relay logo, powered-by badge, and animation.

IMPORTANT: Write the updated file to disk at site/index.html.
Do NOT just output the HTML to stdout.

Relay nav component (contains the logo SVG):
{{steps.read-relay-nav.output}}

Current HTML:
{{steps.read-current-html.output}}

Hero animation JS:
{{steps.read-animation.output}}

Changes needed:

1. RELAY LOGO — replace the diamond icon in the nav and footer with the
   Agent Relay logo SVG from the relay nav component. Extract the SVG
   path/element and use it inline. Keep "relaycast" as the text next to it.

2. "POWERED BY AGENT RELAY" BADGE — add a subtle badge in the footer:
   <div class="powered-by">
     Powered by <a href="https://agentrelay.dev">Agent Relay</a>
   </div>
   Style it as small, muted text with the relay logo inline.

3. HERO ANIMATION — add the animation container to the hero section:
   - Add <div id="hero-animation" class="hero-animation"></div> inside .hero,
     before the text content
   - Add <script src="hero-animation.js"></script> before </body>
   - Add an inline script to initialize: initHeroAnimation('hero-animation')
   - The hero section needs position: relative for the absolute animation

4. Keep the hero-badge "Now in public beta"
5. DO NOT change any text content or section structure
6. DO NOT remove data-telemetry-cta attributes or PostHog meta tags
7. DO NOT change Google Fonts link`,
      verification: { type: 'exit_code' },
    })

    // ── Phase 3: Verify and review ──────────────────────────────────────

    .step('verify-files', {
      type: 'deterministic',
      dependsOn: ['restyle-css', 'update-html'],
      command:
        'missing=0; ' +
        'for f in site/styles.css site/index.html site/hero-animation.js; do ' +
        '  if [ ! -f "$f" ]; then echo "MISSING: $f"; missing=$((missing+1)); fi; ' +
        'done; ' +
        'if [ $missing -gt 0 ]; then echo "$missing files missing"; exit 1; fi; ' +
        'echo "All files present"',
      failOnError: true,
      captureOutput: true,
    })

    .step('verify-dark-mode', {
      type: 'deterministic',
      dependsOn: ['verify-files'],
      command: [
        'echo "=== Dark mode default check ==="',
        'grep -c "#0F1117\\|rgba(15, 17, 23" site/styles.css || echo "WARN: dark bg colors missing"',
        'echo ""',
        'echo "=== Relay logo check ==="',
        'grep -c "agentrelay\\|agent-relay\\|Powered by" site/index.html || echo "WARN: relay branding missing"',
        'echo ""',
        'echo "=== Animation check ==="',
        'grep -c "hero-animation" site/index.html || echo "WARN: animation not wired"',
        'echo ""',
        'echo "=== Gradient check ==="',
        'grep -c "hero-gradient\\|linear-gradient" site/styles.css || echo "WARN: gradient missing"',
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
      dependsOn: ['verify-dark-mode'],
      command: 'git diff --stat site/ && echo "---FULL DIFF---" && git diff site/',
      captureOutput: true,
      failOnError: false,
    })

    .step('review', {
      agent: 'reviewer',
      dependsOn: ['capture-diff', 'verify-dark-mode'],
      task: `Review the dark mode, relay branding, animation, and gradient refinements.

Verification:
{{steps.verify-dark-mode.output}}

Diff:
{{steps.capture-diff.output}}

Review checklist:
1. Dark mode is the default (:root uses dark values)
2. Relay logo SVG is in nav and footer (not the old diamond)
3. "Powered by Agent Relay" appears in footer with link
4. Hero animation JS is loaded and initialized
5. Hero has gradient background matching relay style
6. Syntax highlighting colors work on dark background
7. Cards, buttons, nav all styled for dark mode
8. All responsive breakpoints preserved
9. No broken HTML structure
10. PostHog and telemetry attributes intact
11. Animation is messaging-focused (channels, DMs, threads)

If you find issues, list them with file:line references.`,
    })

    .onError('fail-fast')
    .run({
      onEvent: (e) => console.log(`[${e.type}] ${e.step ?? ''}`),
    });

  console.log('Result:', result.status);
}

main().catch(console.error);


