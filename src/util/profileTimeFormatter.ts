/** Formats `number` nanoseconds as a human-readable duration using a
 *  three-tier auto-scale (ms / µs / ns). Mirrors SwiftUI's
 *  `ProfileTimeFormatter.format(ns:)` exactly so visual parity holds.
 *
 *  Output examples:
 *    - 432_430_000 → "432.43 ms"
 *    - 55_560      → "55.56 µs"
 *    - 209         → "209 ns"
 *    - 0           → "0 ns"
 *
 *  Returns "—" (em dash) for nil — visually distinguishes "stat not
 *  reported" from "stat is zero". */
const NS_PER_MICRO = 1000;
const NS_PER_MILLI = 1_000_000;

export function formatNs(ns: number | null | undefined): string {
  if (ns === null || ns === undefined) { return '—'; }
  const sign = ns < 0 ? '-' : '';
  const magnitude = Math.abs(ns);
  if (magnitude >= NS_PER_MILLI) {
    return `${sign}${(magnitude / NS_PER_MILLI).toFixed(2)} ms`;
  }
  if (magnitude >= NS_PER_MICRO) {
    return `${sign}${(magnitude / NS_PER_MICRO).toFixed(2)} µs`;
  }
  return `${sign}${magnitude} ns`;
}

/** Renders `ns / totalNs` as a percentage string. Returns null when
 *  the input is missing, the denominator is non-positive, or the
 *  share is strictly below `threshold` (default 5%). Pass `threshold: 0`
 *  to force a label for every reporting operator. Mirrors SwiftUI
 *  `ProfileTimeFormatter.percentOfTotal`. */
export function percentOfTotal(
  ns: number | null | undefined,
  totalNs: number,
  threshold = 0.05,
): string | null {
  if (ns === null || ns === undefined) { return null; }
  if (totalNs <= 0) { return null; }
  const share = ns / totalNs;
  if (share < threshold) { return null; }
  return `${(share * 100).toFixed(1)}%`;
}
