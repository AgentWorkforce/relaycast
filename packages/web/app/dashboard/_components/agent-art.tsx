"use client";

import { useEffect, useState } from "react";

/**
 * Deterministic generated art for custom agents that have no card image.
 * Renders a seeded "constellation" — connected nodes over an Agent Relay blue
 * gradient, evoking agents working in synergy. Same seed → same image, so a
 * given agent always looks the same. Pure inline SVG, no network.
 *
 * Animation is deliberately faint and slow (a gentle glow breathe + a couple
 * of slow-twinkling nodes) and is fully disabled under prefers-reduced-motion.
 */

function hashSeed(seed: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Small deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Shared keyframes (identical across every tile, so duplicate <style> blocks
// are harmless). Kept very low-amplitude and slow so it never distracts.
const ANIM_CSS = `
@keyframes synBreathe { 0%,100% { opacity: .82 } 50% { opacity: 1 } }
@keyframes synTwinkle { 0%,100% { opacity: .5 } 50% { opacity: .95 } }
.syn-glow { animation: synBreathe 9s ease-in-out infinite; transform-origin: center; }
.syn-node { animation: synTwinkle 6s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .syn-glow, .syn-node { animation: none; }
}
`;

export function SyntheticAgentArt({
  seed,
  className,
  title,
}: {
  seed: string;
  className?: string;
  title?: string;
}) {
  const hash = hashSeed(seed || "agent");
  const rand = mulberry32(hash);

  // Keep hues in a tight Agent Relay blue band (no violet). Brand blue sits at
  // hue ~204; we wander only a little so tiles stay recognisably on-brand.
  const baseHue = 198 + Math.floor(rand() * 14); // 198..211
  const hueB = baseHue + 4 + Math.floor(rand() * 8); // a touch deeper, still blue
  const c1 = `hsl(${baseHue} 68% 58%)`;
  const c2 = `hsl(${hueB} 72% 40%)`;
  const dark = `hsl(${baseHue} 46% 11%)`;

  const count = 5 + Math.floor(rand() * 3); // 5..7 nodes
  const nodes = Array.from({ length: count }, () => ({
    x: 9 + rand() * 46,
    y: 9 + rand() * 46,
    r: 1.5 + rand() * 2.1,
    // stagger the twinkle so nodes don't pulse in lockstep
    delay: -(rand() * 6).toFixed(2),
    twinkle: rand() < 0.45,
  }));

  // Connect each node to its nearest neighbour → a lightweight network graph.
  const edges: Array<[number, number]> = [];
  for (let i = 0; i < nodes.length; i += 1) {
    let best = -1;
    let bestD = Infinity;
    for (let j = 0; j < nodes.length; j += 1) {
      if (i === j) continue;
      const d = (nodes[i].x - nodes[j].x) ** 2 + (nodes[i].y - nodes[j].y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    if (best >= 0) edges.push([i, best]);
  }

  // Unique per page because callers seed with a unique slug / agentId.
  const gid = `syn-${hash.toString(36)}`;

  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      preserveAspectRatio="xMidYMid slice"
      role="img"
      aria-label={title ?? "Custom agent"}
    >
      <style>{ANIM_CSS}</style>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={c1} />
          <stop offset="1" stopColor={c2} />
        </linearGradient>
        <radialGradient id={`${gid}-glow`} cx="0.5" cy="0.38" r="0.75">
          <stop offset="0" stopColor="white" stopOpacity="0.4" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="64" height="64" fill={dark} />
      <rect width="64" height="64" fill={`url(#${gid})`} opacity="0.55" />
      <rect className="syn-glow" width="64" height="64" fill={`url(#${gid}-glow)`} />
      {edges.map(([a, b], i) => (
        <line
          key={i}
          x1={nodes[a].x}
          y1={nodes[a].y}
          x2={nodes[b].x}
          y2={nodes[b].y}
          stroke="white"
          strokeOpacity="0.4"
          strokeWidth="0.6"
        />
      ))}
      {nodes.map((n, i) => (
        <g key={i}>
          <circle cx={n.x} cy={n.y} r={n.r + 1.6} fill="white" opacity="0.12" />
          <circle
            cx={n.x}
            cy={n.y}
            r={n.r}
            fill="white"
            opacity="0.92"
            className={n.twinkle ? "syn-node" : undefined}
            style={n.twinkle ? { animationDelay: `${n.delay}s` } : undefined}
          />
        </g>
      ))}
    </svg>
  );
}

/**
 * Agent thumbnail: shows the card image when present and loadable, otherwise
 * the generated synergy art. Handles a broken/404 image via onError so a
 * missing card-sm.png degrades to art instead of a broken-image icon.
 * `className` controls sizing/border/rounding for both branches.
 */
export function AgentThumb({
  imageUrl,
  seed,
  name,
  className,
}: {
  imageUrl: string | null;
  seed: string;
  name: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [imageUrl]);

  if (!imageUrl || failed) {
    return <SyntheticAgentArt seed={seed} title={`${name} art`} className={className} />;
  }

  return (
    <img
      src={imageUrl}
      alt=""
      className={className ? `${className} object-cover` : "object-cover"}
      onError={() => setFailed(true)}
    />
  );
}
