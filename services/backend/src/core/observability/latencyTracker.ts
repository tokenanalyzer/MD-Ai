const MAX_SAMPLES_PER_ROUTE = 200;
const samplesByRoute = new Map<string, number[]>();

export function recordLatency(route: string, ms: number): void {
  let arr = samplesByRoute.get(route);
  if (!arr) {
    arr = [];
    samplesByRoute.set(route, arr);
  }
  arr.push(ms);
  if (arr.length > MAX_SAMPLES_PER_ROUTE) arr.shift();
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx] ?? 0;
}

export interface RouteLatencyStats {
  p50: number;
  p95: number;
  count: number;
}

/** Cheap in-memory p50/p95 per route — no external APM (docs/architecture/08-deployment-architecture.md §9.1). */
export function getLatencyStats(): Record<string, RouteLatencyStats> {
  const result: Record<string, RouteLatencyStats> = {};
  for (const [route, samples] of samplesByRoute) {
    const sorted = [...samples].sort((a, b) => a - b);
    result[route] = { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), count: samples.length };
  }
  return result;
}

export function resetLatencyStatsForTests(): void {
  samplesByRoute.clear();
}
