"use client";

import { useEffect, useRef } from "react";

type MessageKind = "channel" | "dm" | "thread" | "reaction";

interface Node {
  baseX: number;
  baseY: number;
  x: number;
  y: number;
  driftPhase: number;
  driftSpeed: number;
  driftAmpX: number;
  driftAmpY: number;
  glowOpacity: number;
}

interface Pulse {
  from: number;
  to: number;
  t: number;
  speed: number;
  trail: { x: number; y: number; age: number }[];
  kind: MessageKind;
}

const TRAIL_COLORS: Record<MessageKind, string> = {
  channel: "rgba(74, 144, 194,",
  dm: "rgba(99, 209, 139,",
  thread: "rgba(193, 103, 75,",
  reaction: "rgba(254, 188, 46,",
};

const NODE_COLORS: Record<MessageKind, string> = {
  channel: "rgba(74, 144, 194,",
  dm: "rgba(99, 209, 139,",
  thread: "rgba(193, 103, 75,",
  reaction: "rgba(254, 188, 46,",
};

const KINDS: MessageKind[] = ["channel", "dm", "thread", "reaction"];
const NODE_COUNT = 8;

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function easeInOut(t: number) {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function buildPositions(): { x: number; y: number }[] {
  const cx = 0.5;
  const cy = 0.5;
  const positions: { x: number; y: number }[] = [{ x: cx, y: cy }];
  const ringCount = 7;
  const radius = 0.32;

  for (let i = 0; i < ringCount; i++) {
    const angle = (i / ringCount) * Math.PI * 2 - Math.PI * 0.1;
    const jx = Math.sin((i + 1) * 7.3) * 0.012;
    const jy = Math.cos((i + 1) * 5.1) * 0.01;
    positions.push({
      x: cx + Math.cos(angle) * radius + jx,
      y: cy + Math.sin(angle) * radius * 0.85 + jy,
    });
  }

  return positions;
}

const POSITIONS = buildPositions();

function buildConnections(): [number, number][] {
  const connections: [number, number][] = [];
  const threshold = 0.38;

  for (let i = 0; i < NODE_COUNT; i++) {
    for (let j = i + 1; j < NODE_COUNT; j++) {
      const dx = POSITIONS[i].x - POSITIONS[j].x;
      const dy = POSITIONS[i].y - POSITIONS[j].y;
      if (Math.sqrt(dx * dx + dy * dy) < threshold) {
        connections.push([i, j]);
      }
    }
  }

  return connections;
}

const CONNECTIONS = buildConnections();

function createNodes(): Node[] {
  return POSITIONS.map((position) => ({
    baseX: position.x,
    baseY: position.y,
    x: position.x,
    y: position.y,
    driftPhase: Math.random() * Math.PI * 2,
    driftSpeed: 0.0004 + Math.random() * 0.0004,
    driftAmpX: 0.01 + Math.random() * 0.015,
    driftAmpY: 0.008 + Math.random() * 0.012,
    glowOpacity: 0,
  }));
}

function drawFrame(
  ctx: CanvasRenderingContext2D,
  nodes: Node[],
  pulses: Pulse[],
  width: number,
  height: number,
  frame: number,
) {
  ctx.clearRect(0, 0, width, height);

  for (const node of nodes) {
    const t = frame * node.driftSpeed + node.driftPhase;
    node.x = node.baseX + Math.sin(t) * node.driftAmpX + Math.cos(t * 0.7) * node.driftAmpX * 0.5;
    node.y = node.baseY + Math.cos(t * 1.3) * node.driftAmpY + Math.sin(t * 0.5) * node.driftAmpY * 0.4;
    node.glowOpacity = Math.max(node.glowOpacity - 0.012, 0);
  }

  const centers = nodes.map((node) => ({ cx: node.x * width, cy: node.y * height }));

  for (const [i, j] of CONNECTIONS) {
    ctx.beginPath();
    ctx.moveTo(centers[i].cx, centers[i].cy);
    ctx.lineTo(centers[j].cx, centers[j].cy);
    ctx.strokeStyle = "rgba(74, 144, 194, 0.08)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const center = centers[i];

    if (node.glowOpacity > 0.01) {
      const radius = 60;
      const alpha = node.glowOpacity * 0.15;
      const gradient = ctx.createRadialGradient(center.cx, center.cy, radius * 0.3, center.cx, center.cy, radius);
      gradient.addColorStop(0, `rgba(74, 144, 194, ${alpha})`);
      gradient.addColorStop(1, "rgba(74, 144, 194, 0)");
      ctx.beginPath();
      ctx.arc(center.cx, center.cy, radius, 0, Math.PI * 2);
      ctx.fillStyle = gradient;
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(center.cx, center.cy, 4 + node.glowOpacity * 2, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(74, 144, 194, ${0.3 + node.glowOpacity * 0.5})`;
    ctx.fill();
  }

  for (let pulseIndex = pulses.length - 1; pulseIndex >= 0; pulseIndex--) {
    const pulse = pulses[pulseIndex];
    pulse.t += pulse.speed;

    const from = centers[pulse.from];
    const to = centers[pulse.to];
    const progress = easeInOut(Math.min(pulse.t, 1));
    const px = lerp(from.cx, to.cx, progress);
    const py = lerp(from.cy, to.cy, progress);

    pulse.trail.push({ x: px, y: py, age: 0 });

    const color = TRAIL_COLORS[pulse.kind];
    for (let trailIndex = pulse.trail.length - 1; trailIndex >= 0; trailIndex--) {
      const point = pulse.trail[trailIndex];
      point.age++;
      const trailAlpha = Math.max(0, 0.4 - point.age * 0.004);
      if (trailAlpha <= 0) {
        pulse.trail.splice(trailIndex, 1);
        continue;
      }

      const size = Math.max(1.5, 5 - point.age * 0.04);
      ctx.beginPath();
      ctx.arc(point.x, point.y, size, 0, Math.PI * 2);
      ctx.fillStyle = `${color} ${trailAlpha})`;
      ctx.fill();
    }

    if (pulse.t <= 1) {
      const headColor = NODE_COLORS[pulse.kind];
      ctx.beginPath();
      ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.fillStyle = `${headColor} 0.8)`;
      ctx.fill();

      const gradient = ctx.createRadialGradient(px, py, 3, px, py, 18);
      gradient.addColorStop(0, `${headColor} 0.3)`);
      gradient.addColorStop(1, `${headColor} 0)`);
      ctx.beginPath();
      ctx.arc(px, py, 18, 0, Math.PI * 2);
      ctx.fillStyle = gradient;
      ctx.fill();
    }

    if (pulse.t > 1) {
      nodes[pulse.to].glowOpacity = 1;
      pulses.splice(pulseIndex, 1);
    }
  }
}

export function SigninBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    const nodes = createNodes();
    const pulses: Pulse[] = [];
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let lastPulseFrame = 0;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = window.innerWidth;
      const height = window.innerHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const spawnPulse = () => {
      const from = Math.floor(Math.random() * NODE_COUNT);
      const neighbors = CONNECTIONS
        .filter(([a, b]) => a === from || b === from)
        .map(([a, b]) => (a === from ? b : a));

      if (neighbors.length === 0) {
        return;
      }

      const to = pick(neighbors);
      pulses.push({
        from,
        to,
        t: 0,
        speed: 0.012 + Math.random() * 0.008,
        trail: [],
        kind: pick(KINDS),
      });
      nodes[from].glowOpacity = 1;
    };

    const render = () => {
      drawFrame(ctx, nodes, pulses, window.innerWidth, window.innerHeight, frame);
    };

    const draw = () => {
      frame++;
      render();

      if (frame - lastPulseFrame > 30 + Math.random() * 40) {
        spawnPulse();
        lastPulseFrame = frame;
        if (Math.random() < 0.4) {
          spawnPulse();
        }
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    const startOrRenderStatic = () => {
      cancelAnimationFrame(rafRef.current);
      frame = 0;
      pulses.length = 0;

      for (const node of nodes) {
        node.x = node.baseX;
        node.y = node.baseY;
        node.glowOpacity = 0;
      }

      if (mediaQuery.matches) {
        render();
        return;
      }

      for (let i = 0; i < 3; i++) {
        spawnPulse();
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    resize();
    startOrRenderStatic();

    window.addEventListener("resize", resize);
    mediaQuery.addEventListener("change", startOrRenderStatic);

    return () => {
      window.removeEventListener("resize", resize);
      mediaQuery.removeEventListener("change", startOrRenderStatic);
      cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden="true">
      <canvas
        ref={canvasRef}
        className="absolute inset-0"
        style={{ filter: "blur(6px)" }}
      />
    </div>
  );
}
