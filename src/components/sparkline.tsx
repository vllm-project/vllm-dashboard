/**
 * A tiny inline trend line. Renders nothing meaningful for fewer than two
 * points, so callers can pass whatever history they have.
 */
export function Sparkline({
  values,
  width = 72,
  height = 22,
  className = "",
  title,
}: {
  values: readonly number[];
  width?: number;
  height?: number;
  className?: string;
  title?: string;
}) {
  const points = values.filter((value) => Number.isFinite(value));
  if (points.length < 2) return null;

  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const padY = 2;
  const stepX = width / (points.length - 1);
  const coords = points.map((value, index) => {
    const x = index * stepX;
    const y = height - padY - ((value - min) / span) * (height - padY * 2);
    return [x, y] as const;
  });
  const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `0,${height} ${line} ${width},${height}`;
  const [lastX, lastY] = coords[coords.length - 1];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      className={`overflow-visible ${className}`}
    >
      {title && <title>{title}</title>}
      <polygon points={area} fill="currentColor" opacity={0.08} />
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={lastX} cy={lastY} r={1.8} fill="currentColor" />
    </svg>
  );
}
