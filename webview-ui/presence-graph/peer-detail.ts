// webview-ui/presence-graph/peer-detail.ts
//
// The data contract for the Presence Graph's peer detail card, mirroring
// SwiftUI's PresencePeerDetail + the formatting rules of PeerDetailCardView.
//
// Every field except the sync trio comes from the presence graph, which
// reports the same shape whether or not the local device can reach the
// peer — so the card is fully populated for multi-hop peers too. The sync
// fields come from `system:data_sync_info`, a local table with rows only
// for peers WE hold a session with; `isDirectlyConnected` lets the card
// distinguish "a session exists and nothing has synced yet" from "there
// is no session to report on".

export interface PresencePeerCardDetail {
  peerKey: string;
  /** "Me" for the local device; the device name; or the first 8 chars of
   *  the peer key when the peer reports no name. */
  displayName: string;
  isLocal: boolean;

  // Presence-graph facts — available for multi-hop peers as well.
  os?: string | undefined;
  sdkVersion?: string | undefined;
  /** `undefined` = not yet known (transient pre-presence snapshots). */
  cloudLink?: boolean | undefined;
  isCompatible?: boolean | undefined;
  /** Top-level key counts — never the raw documents (the SDK caps each
   *  object at 4 KB, which no card can hold). 0 = none set. */
  peerMetadataKeyCount: number;
  identityMetadataKeyCount: number;

  // Sync session — direct peers only, see the header comment.
  isDirectlyConnected: boolean;
  syncedUpToLocalCommitId?: number | undefined;
  lastUpdateReceivedTime?: number | undefined;
}

/** "N keys" summary for metadata rows; undefined renders as the row's
 *  missing placeholder ("—"). Mirrors metadataSummary in SwiftUI. */
export function metadataKeySummary(keyCount: number): string | undefined {
  if (keyCount <= 0) { return undefined; }
  return keyCount === 1 ? '1 key' : `${keyCount} keys`;
}

/** SwiftUI PeerDetailCardView.formattedLastUpdate parity: relative for the
 *  last day, absolute beyond it; undefined when there is nothing to show
 *  (the row then renders "never"). */
export function formatLastUpdateMs(
  ms: number | undefined,
  now: number,
): string | undefined {
  if (!ms || ms <= 0) { return undefined; }
  const absolute = new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const elapsedSec = (now - ms) / 1000;
  if (elapsedSec < 0) { return absolute; }
  if (elapsedSec < 60) { return 'Just now'; }
  if (elapsedSec < 3600) { return `${Math.floor(elapsedSec / 60)} min ago`; }
  if (elapsedSec < 86400) { return `${Math.floor(elapsedSec / 3600)} hr ago`; }
  return absolute;
}
