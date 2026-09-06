/**
 * Log-source taxonomy for the Log Analyzer's source tabs.
 *
 * Mirrors the SwiftUI/Android Edge Studio Log Analyzer, which keeps
 * separate entry sources (`LogEntrySource`): the SDK log itself plus two
 * log-only SDK callback streams — transport conditions
 * (`Ditto.observeTransportConditions`) and incoming connection requests
 * (`ditto.presence.connectionRequestHandler`). Here those streams are
 * emitted through the extension Logger under dedicated tags
 * (`src/ditto/session-log-observers.ts`), so they share the log file,
 * the analyzer buffer, search, pattern scanning and histograms; the
 * source tab is therefore a tag filter rather than a separate buffer.
 *
 * The tag values are load-bearing in two directions: they are how
 * `LogAnalyzerService.queryLines` recognizes a source, and they appear in
 * the table's Tag column and in persisted log files. Change them only with
 * a deliberate cross-version decision.
 */
export const TRANSPORT_CONDITIONS_TAG = 'transport';
export const CONNECTION_REQUESTS_TAG = 'connection-request';

/** Identifiers for the Log Analyzer source tabs. Matches the `source`
 *  field on `analyzer.queryLines` (`src/ipc/messages.ts`). */
export type AnalyzerSource = 'all' | 'transport' | 'connectionRequests';

/** The logger tag a source tab filters on, or `null` for the 'all' tab.
 *  `'all'` deliberately means "every tag", including the two event-source
 *  tags — the event lines are part of the chronological stream too. */
export function logTagForSource(source: AnalyzerSource | undefined): string | null {
  switch (source) {
    case 'transport': return TRANSPORT_CONDITIONS_TAG;
    case 'connectionRequests': return CONNECTION_REQUESTS_TAG;
    default: return null;
  }
}
