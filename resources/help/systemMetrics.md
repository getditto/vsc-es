# System Metrics

The System Metrics panel is a live dashboard fed by Ditto SDK 5.1's
`system:metrics` virtual collection: DSOQ network counters, SQLite
metrics per database role, and replication recovery counters. For
point-in-time **storage** numbers (disk usage, per-collection payload
sizes) use the separate **Database Metrics** screen.

The panel polls every 5 seconds **while it is visible** (the footer shows
the accumulation window and last poll time). Refresh forces one immediate
poll ahead of that cadence.

## Filtering and details

Every metric series reported by the SDK renders as a row: the metric name
(with the `ditto.` prefix dropped) and its labels on the left, the
since-connect total and the last poll period's delta (`▲ +N`, `▼ −N` for
gauges whose value fell, or `—` when nothing happened) on the right.
Gauge series (e.g. `transport.awdl.interface_up`,
`multiplexer.phy.last_sent_at`) show their current absolute value instead
of a running total; epoch-timestamp gauges render as an age (`12s ago`).

The segment control filters rows by namespace. Each series appears under
exactly one topic:

- **Discovery** — peer discovery (`ditto.discovery.*`): mDNS and multicast
  DNS-SD browse/registration sessions and advertised-interface counts.
- **Network** — connection and DSOQ counters (`ditto.network.*`). Watch
  opened vs closed counts: divergence raises a banner about a possible
  connection leak or handshake instability; non-zero `tlv.unknown_type_*`
  counts indicate interop/version skew between peers.
- **Sync** — the replication engine and everything that moves documents
  between peers: replication sessions (`ditto.sync.*`,
  `ditto.replication.*`), the diffcaster mesh (`ditto.diffcaster.*`), the
  RIBLT set-reconciliation sketch (`ditto.riblt.*`), presence evidence
  (`ditto.presence.*`), and the sync byte stream (`ditto.stream.*`).
  Non-zero recovery/session-reset counts mean sync sessions were torn down
  — check the `cause` label and the Log Analyzer.
- **Transport** — the link layer: the physical/virtual multiplexer
  (`ditto.multiplexer.*`), the UDP multicast (NORM) transport and its
  attachment mover (`ditto.multicast.*`, `ditto.multicast_attachment.*`),
  and the per-protocol transports (`ditto.transport.*` — UDP, TCP, BLE,
  AWDL, WiFi-Aware, websocket).
- **Store** — the persistence layer: the storage engine (`ditto.backend.*`
  — sqlite3 txns/fsync/WAL, labelled per database role), the store API
  (`ditto.store.*`), small-peer-info writes (`ditto.small_peer_info.*`), and
  blob/attachment storage tiers (`ditto.storage.*`, `ditto.blob_storage.*`).
  Rising fsync/checkpoint durations mean disk pressure; a WAL that only
  grows means checkpoints aren't keeping up with writers.
- **Query** — query-engine metrics: the OTLP series (`ditto.query.*`, SDK
  5.2+) and their legacy `dql.*` aliases, which the SDK dual-emits
  alongside (`dql.requests` carries the same count as
  `ditto.query.requests`).
- **Peer** — peer identity and the attachment P2P transfer state machine
  (`ditto.peer.*`): revocation handshakes, attachment link maintenance and
  fetch lifecycle.
- **All** — every reported series. The metrics pipeline's own telemetry
  (`ditto.metrics.*`, `ditto.metrics_exporter.*`, `ditto.system_info.*`)
  and anything the SDK adds that hasn't been routed to a topic yet appear
  here only — there is no separate "Other" segment.

The **search box** (right of the segments) narrows the list to series whose
metric name or labels contain the term, case-insensitively — for example
`ble` finds every `transport=ble` series and `dsoq` every dsoq metric.
Search and the segment filter compose (Store + `wal` → the WAL metrics of
the Store namespace). The Pinned section is not affected by either filter —
it is your stable set.

The master list is sorted **alphabetically by metric name**, so you can
scan straight to a series instead of searching; series that share a name
(a rare label-only pair) order by their labels. The Pinned section keeps
the order you set by dragging — it is not sorted.

The **ⓘ icon** on a row expands the series' details: the metric's
description from the SDK registry, its kind (counter / gauge / histogram)
and unit, the full metric name, and — for histograms — the average and
absolute maximum since connect.

## Pinning

When you're troubleshooting, pin the handful of series you care about
with the **pin icon** on any row. Pinned series collect in a collapsible
**Pinned** section above the namespace filter, so 5–10 key metrics stay in
view without hunting through the full list. Pinning does not remove the
series from the main list, the section ignores the namespace filter, and
rows show the same live values. A pinned series with no data yet this
connection stays visible with a `—` placeholder so you can always unpin it
(either there or from its row in the main list). **Clear** empties the
whole pinned set.

Reorder pinned series by **dragging**: every pinned row is a drag source
(grab anywhere, or use the ☰ handle at the row's right edge). Drop above a
row's middle to insert before it, below to insert after it — the order you
set is the order they're remembered in.

Pins are remembered per connection: they survive closing the panel,
disconnecting and reconnecting, and restarting the editor.

---

## Why totals "since connect"

Every read of `system:metrics` **flushes** Ditto's metric registry —
each row reports only what happened since the previous read. The
extension therefore accumulates those per-read deltas into running
totals that start at zero when the extension connects, and the header
of each table pair tells you what window the numbers cover ("Since
connect" vs "Last period").

Because reads flush, polling pauses while the panel is hidden: an
invisible poll would consume counters without showing them to anyone.
Nothing is lost — the missed activity folds into the next poll's delta.

## If the panel says metrics are disabled

The `system:metrics` exporter is **startup-gated**: the SDK reads the
parameter once when a connection opens and ignores runtime changes. If
this connection was opened with metrics collection off:

1. Enable the `dittoVsce.collectSystemMetrics` setting.
2. Disconnect and reconnect the database.

## Reading the banner

When dsoq connections opened ≠ closed since connect, an amber banner calls
it out: that divergence indicates a connection leak or handshake
instability. Follow up in the Log Analyzer with transport filters.
