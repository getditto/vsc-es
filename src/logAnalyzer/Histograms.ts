import type { LogLevel } from '../logging/types.js';
import type { LogLine } from './types.js';

const NICE_BINS_MS = [1000, 5000, 30_000, 60_000, 300_000, 600_000, 1_800_000];

export function pickBinWidth(rangeMs: number, target = 40): number {
  const want = rangeMs / target;
  for (const v of NICE_BINS_MS) if (v >= want) return v;
  return NICE_BINS_MS.at(-1) ?? 1_800_000;
}

export function binVolumeByLevel(
  lines: LogLine[], binMs: number,
): { binStartMs: number; counts: Record<LogLevel, number> }[] {
  if (lines.length === 0) return [];
  const out = new Map<number, Record<LogLevel, number>>();
  for (const l of lines) {
    if (!l.timestamp) continue;
    const bin = Math.floor(l.timestamp.getTime() / binMs) * binMs;
    let bucket = out.get(bin);
    if (!bucket) {
      bucket = { error: 0, warn: 0, info: 0, debug: 0, trace: 0 };
      out.set(bin, bucket);
    }
    bucket[l.level]++;
  }
  return [...out.entries()]
    .sort(([a], [b]) => a - b)
    .map(([binStartMs, counts]) => ({ binStartMs, counts }));
}

export interface ProblemHit { time: Date; severity: 1|2|3|4|5; }

export function binProblemsOverTime(
  problems: ProblemHit[], binMs: number,
): { binStartMs: number; count: number; maxSeverity: 1|2|3|4|5 }[] {
  if (problems.length === 0) return [];
  const out = new Map<number, { count: number; maxSeverity: 1|2|3|4|5 }>();
  for (const p of problems) {
    const bin = Math.floor(p.time.getTime() / binMs) * binMs;
    const cur = out.get(bin) ?? { count: 0, maxSeverity: 1 as 1|2|3|4|5 };
    cur.count++;
    if (p.severity > cur.maxSeverity) cur.maxSeverity = p.severity;
    out.set(bin, cur);
  }
  return [...out.entries()]
    .sort(([a], [b]) => a - b)
    .map(([binStartMs, v]) => ({ binStartMs, ...v }));
}

const DURATION_BINS: { label: string; max: number }[] = [
  { label: '0–1s',   max: 1 },
  { label: '1–5s',   max: 5 },
  { label: '5–30s',  max: 30 },
  { label: '30s–5m', max: 300 },
  { label: '5m+',    max: Infinity },
];

export function binDurations(
  sessions: { duration: number }[],
): { binLabel: string; count: number }[] {
  const out = DURATION_BINS.map(b => ({ binLabel: b.label, count: 0 }));
  for (const s of sessions) {
    const i = DURATION_BINS.findIndex(b => s.duration < b.max);
    const bin = i >= 0 ? out[i] : undefined;
    if (bin) bin.count++;
  }
  return out;
}
