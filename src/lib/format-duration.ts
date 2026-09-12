/**
 * Compact duration for trace timelines: sub-second values keep millisecond
 * precision, short values keep one decimal, and longer values step up to
 * `Xm Ys` and `Xh Ym`. Shared by the build waterfall and its GPU panel so
 * both axes read the same way.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) {
    const seconds = ms / 1_000;
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  }
  const totalSeconds = Math.round(ms / 1_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}
