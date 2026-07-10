"use client";

export function Sparkline({
  points,
  stroke = "var(--brand-primary)",
}: {
  points: number[];
  stroke?: string;
}) {
  const filtered = points.filter((value) => Number.isFinite(value));
  if (filtered.length === 0 || filtered.every((value) => value === 0)) {
    return <div className="h-12 rounded-md bg-[var(--surface-soft)]" />;
  }

  const max = Math.max(...filtered, 1);
  const min = Math.min(...filtered, 0);
  const spread = Math.max(1, max - min);
  const plot = filtered
    .map((value, index) => {
      const x = (index / Math.max(filtered.length - 1, 1)) * 100;
      const y = 100 - ((value - min) / spread) * 100;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg viewBox="0 0 100 100" className="h-12 w-full overflow-visible">
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={plot}
      />
    </svg>
  );
}
