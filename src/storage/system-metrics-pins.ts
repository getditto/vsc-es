import type { MementoLike } from './MetricsPreferencesStore.js';
import type { SystemMetricSeriesRef } from '../ipc/messages.js';

/**
 * Per-database pinned system-metrics series, persisted in `globalState`
 * (a versioned key per databaseId) so a developer's troubleshooting set
 * survives the panel closing, a database disconnect/reconnect, and an
 * editor restart. The webview sends the complete list on every edit, so
 * writes here are wholesale replacements — there is no merge to get wrong.
 */

const KEY_PREFIX = 'dittoSystemMetricsPins.v1.';

function pinsKey(databaseId: string): string {
  return `${KEY_PREFIX}${databaseId}`;
}

/** Per-series signature (metric key + sorted label map) — same scheme as
 *  the accumulator (SystemMetricsService.seriesSignature) and the webview
 *  element's seriesId, so all three agree on what "the same series" means. */
function seriesSignature(ref: SystemMetricSeriesRef): string {
  const labels = Object.keys(ref.labels).sort().map(k => `${k}=${ref.labels[k]}`).join(',');
  return `${ref.key}{${labels}}`;
}

/** First-occurrence-wins dedupe. Pins are a SET presented in pin order:
 *  the same metric series may never appear twice, no matter which writer
 *  (legacy storage contents, a mid-development list, a racing webview
 *  message) produced the input. Module-private: both public entry points
 *  (readPins / writePins) funnel through it. */
function dedupePins(pins: SystemMetricSeriesRef[]): SystemMetricSeriesRef[] {
  const seen = new Set<string>();
  return pins.filter(p => {
    const sig = seriesSignature(p);
    if (seen.has(sig)) { return false; }
    seen.add(sig);
    return true;
  });
}

/** Pinned series for one connection, in pin order. Malformed stored
 *  entries are dropped rather than failing the whole read — globalState
 *  is user-editable (`@storage` inspection) and older versions may have
 *  written a different shape under the same versioned key family. */
export function readPins(memento: MementoLike, databaseId: string): SystemMetricSeriesRef[] {
  const raw = memento.get<unknown>(pinsKey(databaseId));
  if (!Array.isArray(raw)) { return []; }
  const out: SystemMetricSeriesRef[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') { continue; }
    const { key, labels } = entry as { key?: unknown; labels?: unknown };
    if (typeof key !== 'string' || key.length === 0) { continue; }
    const cleanLabels: Record<string, string> = {};
    if (labels && typeof labels === 'object' && !Array.isArray(labels)) {
      for (const [k, v] of Object.entries(labels as Record<string, unknown>)) {
        if (typeof v === 'string') { cleanLabels[k] = v; }
      }
    }
    out.push({ key, labels: cleanLabels });
  }
  return dedupePins(out);
}

/** Replace the pinned list for one connection (deduped first — every
 *  writer funnels through here, so this is the single choke point that
 *  enforces the no-duplicates invariant). An empty list clears the key
 *  entirely so "Clear pins" leaves no residue in storage. */
export async function writePins(
  memento: MementoLike,
  databaseId: string,
  pins: SystemMetricSeriesRef[],
): Promise<void> {
  const unique = dedupePins(pins);
  await memento.update(pinsKey(databaseId), unique.length === 0 ? undefined : unique);
}
