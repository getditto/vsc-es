import type { ConnectionRequest, Ditto, Observer } from '@dittolive/ditto';
import type { Logger } from '../logging/types.js';
import { CONNECTION_REQUESTS_TAG, TRANSPORT_CONDITIONS_TAG } from '../logAnalyzer/log-sources.js';

/**
 * Log-only SDK session observers — the VS Code port of SwiftUI Edge
 * Studio's `DittoLogCaptureService.startTransportConditionObserver` /
 * `startConnectionRequestHandler` (and the Android
 * `DittoLogCaptureService` equivalents). They feed the Log Analyzer's
 * **Transport Conditions** and **Connection Requests** source tabs.
 *
 * Both streams are emitted through the extension Logger at INFO level
 * under dedicated tags, so they flow into the log file (visible to Log
 * Analyzer backfill) and the live analyzer buffer (search, pattern
 * scanning, histograms) with no separate plumbing. The `logger` argument
 * MUST be the extension's root (untagged) logger: `withTag` composes
 * (`x.withTag('a')` → tag `x:a`), and the Log Analyzer's source tabs match
 * the tags exactly, so childing off a tagged logger would make every event
 * invisible to them.
 *
 * The message formats match the SwiftUI/Android strings so support
 * playbooks reading one platform's output read the other:
 *
 *   Transport: <source> → <condition>
 *   Connection Request | type=<connectionType> | key=<peerKey> | identity=<json|none> | meta=<json|none>
 *
 * The connection request handler is LOG-ONLY: it unconditionally returns
 * 'allow' and must never delay or deny a request because its own logging
 * failed — the SDK denies the request if the handler throws or exceeds
 * its response timeout. The SwiftUI counterpart caps these sources at
 * 5,000 in-memory entries; here they age out with the analyzer's normal
 * 50,000-line ring and the log-file rotation, which need no extra caps.
 */
export function installSessionLogObservers(ditto: Ditto, logger: Logger): { dispose(): void } {
  const transportLog = logger.withTag(TRANSPORT_CONDITIONS_TAG);
  const connectionLog = logger.withTag(CONNECTION_REQUESTS_TAG);

  const transportObserver: Observer = ditto.observeTransportConditions((condition, source) => {
    try {
      transportLog.info(`Transport: ${source} → ${condition}`);
    } catch { /* a logging failure must never reach the SDK callback */ }
  });

  const connectionRequestHandler = (request: ConnectionRequest): Promise<'allow'> => {
    try {
      connectionLog.info(
        `Connection Request | type=${request.connectionType} | key=${request.peerKey}` +
        ` | identity=${describeMetadata(request.identityServiceMetadata)}` +
        ` | meta=${describeMetadata(request.peerMetadata)}`,
      );
    } catch { /* log-only: swallow and still allow below */ }
    return Promise.resolve('allow' as const);
  };
  ditto.presence.connectionRequestHandler = connectionRequestHandler;

  return {
    dispose(): void {
      try { transportObserver.stop(); } catch { /* ditto.close() also releases it */ }
      try {
        // Only clear the handler if it is still ours: disposing a torn-down
        // session must not clobber whatever the next connection installed.
        if (ditto.presence.connectionRequestHandler === connectionRequestHandler) {
          ditto.presence.connectionRequestHandler = null;
        }
      } catch { /* instance already closed */ }
    },
  };
}

/** SwiftUI prints the raw dictionary description for non-empty metadata and
 *  'none' when empty; Android logs the SDK's JSON string with the same
 *  'none' fallback. The JS SDK exposes both the parsed record and its
 *  JSON string — JSON.stringify of the record is the direct equivalent. */
function describeMetadata(metadata: Record<string, unknown> | undefined): string {
  if (!metadata || Object.keys(metadata).length === 0) { return 'none'; }
  try {
    return JSON.stringify(metadata);
  } catch {
    return '<unserializable>';
  }
}
